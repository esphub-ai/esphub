/*
 * okou agent core: hub connection, framing and request dispatch (docs/protocol.md v1).
 *
 * The agent task owns MQTT publishing, HTTPS requests and command dispatch.
 * Producer tasks only write bounded queues.
 *
 * SPDX-License-Identifier: MIT
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <inttypes.h>
#include <math.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_pm.h"
#include "freertos/semphr.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "esp_idf_version.h"
#include "esp_ota_ops.h"
#include "esp_heap_caps.h"
#include "sdkconfig.h"
#include "okou_priv.h"
#include "okou_ble.h"
#include "okou_iot.h"

#define TAG OKOU_TAG
#define US_PER_MS 1000LL
#define BACKOFF_RESET_US (60 * 1000000LL)
#define CONNECT_TIMEOUT_US (30 * 1000000LL)
#define MQTT_LOG_INTERVAL_US (10 * 60 * 1000000LL)
#define FLUSH_INTERVAL_US (200 * 1000LL)
#define BACKOFF_MAX_MS 60000
#define METRIC_RING 32
#define MAX_OPS 8

okou_config_t g_okou_cfg = OKOU_CONFIG_DEFAULT();

typedef struct {
    cJSON *id;
    char name[24];
    cJSON *argv;
} poll_job_t;

typedef struct {
    char name[24];
    uint32_t ms;
    double v;
} metric_t;

typedef struct {
    char op[20];
    okou_op_handler_t fn;
    okou_op_async_handler_t afn;
} op_t;

struct okou_req {
    cJSON *id;
};

// A binary semaphore latches work arriving between a state check and sleep.
static SemaphoreHandle_t s_wake;
void okou_agent_notify(void)
{
    if (!s_wake) return;
    if (xPortInIsrContext()) {
        BaseType_t higher = pdFALSE;
        xSemaphoreGiveFromISR(s_wake, &higher);
        if (higher) portYIELD_FROM_ISR();
    } else {
        xSemaphoreGive(s_wake);
    }
}
static QueueHandle_t s_txq, s_pollq;
#if CONFIG_OKOU_BLE_WIFI
static bool s_ble_sync_needed = true;
#endif
static volatile bool s_mqtt_up, s_hello_acked, s_mqtt_broken, s_reload;
static int64_t s_conn_start_us, s_up_since_us, s_last_flush_us, s_next_connect_us;
static int64_t s_next_log_batch_us = MQTT_LOG_INTERVAL_US;
static uint32_t s_log_batch_through;
static cJSON *s_log_request_id;
static uint32_t s_backoff_ms = 1000;
static volatile int64_t s_reboot_at_us;
static char s_boot_id[33];
static bool s_rolled_back;
static char *s_txbuf;
static okou_hooks_t s_hooks;
static char s_install_state[20] = "queued";
static char s_inflight_id[37];
static int64_t s_inflight_until;
static bool s_iot_started, s_pull_due;
static bool s_started, s_cfg_ok;
static char s_hub[OKOU_HUB_HOST_MAX + 1], s_tok[96];
static op_t s_ops[MAX_OPS];
static int s_nops;
static uint32_t s_events_dropped;

static metric_t s_metrics[METRIC_RING];
static uint32_t s_mhead, s_mcount, s_mdropped;
static portMUX_TYPE s_mmux = portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE s_rmux = portMUX_INITIALIZER_UNLOCKED;

static int64_t now_us(void)
{
    return esp_timer_get_time();
}

static void ensure_queues(void)
{
    static portMUX_TYPE m = portMUX_INITIALIZER_UNLOCKED;
    static bool done;
    if (done) {
        return;
    }
    QueueHandle_t tx = xQueueCreate(16, sizeof(char *));
    QueueHandle_t pq = xQueueCreate(4, sizeof(poll_job_t *));
    portENTER_CRITICAL(&m);
    if (!done) {
        s_txq = tx;
        s_pollq = pq;
        done = true;
        tx = pq = NULL;
    }
    portEXIT_CRITICAL(&m);
    if (tx) {
        vQueueDelete(tx);
        vQueueDelete(pq);
    }
}

/* ------------------------------------------------------------------ config */

static bool load_config(void)
{
    s_hub[0] = s_tok[0] = 0;
    if (okou_nvs_get_str("hub", s_hub, sizeof(s_hub)) != ESP_OK || !okou_hub_host_valid(s_hub)) {
        s_hub[0] = 0;
        return false;
    }
    return okou_nvs_get_str(OKOU_KEY_TOKEN, s_tok, sizeof(s_tok)) == ESP_OK && s_tok[0];
}

esp_err_t okou_hub_http_base(char *buf, size_t len)
{
    if (!s_hub[0]) return ESP_ERR_INVALID_STATE;
    int written = snprintf(buf, len, "https://%s", s_hub);
    return written >= 0 && (size_t)written < len ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

void okou_http_apply_auth(esp_http_client_handle_t client)
{
    char h[sizeof(s_tok) + 8];
    snprintf(h, sizeof(h), "Bearer %s", s_tok);
    esp_http_client_set_header(client, "Authorization", h);
}

/* ------------------------------------------------------------------ public small API */

void okou_set_hooks(const okou_hooks_t *hooks)
{
    s_hooks = *hooks;
}

void okou_set_install_state(const char *state)
{
    strlcpy(s_install_state, state, sizeof(s_install_state));
}

bool okou_connected(void) { return s_mqtt_up && s_hello_acked; }

bool okou_mqtt_connected(void) { return s_mqtt_up; }

void okou_agent_reload_config(void)
{
    s_reload = true;
    okou_agent_notify();
}

void okou_schedule_reboot(uint32_t delay_ms)
{
    int64_t t = now_us() + (int64_t)delay_ms * US_PER_MS;
    portENTER_CRITICAL(&s_rmux);
    s_reboot_at_us = t;
    portEXIT_CRITICAL(&s_rmux);
    okou_agent_notify();
}

static esp_err_t op_register(const char *op, okou_op_handler_t handler, okou_op_async_handler_t ahandler)
{
    for (int i = 0; i < s_nops; i++) {
        if (strcmp(s_ops[i].op, op) == 0) {
            s_ops[i].fn = handler;
            s_ops[i].afn = ahandler;
            return ESP_OK;
        }
    }
    if (s_nops >= MAX_OPS || strlen(op) >= sizeof(s_ops[0].op)) {
        return ESP_ERR_NO_MEM;
    }
    strlcpy(s_ops[s_nops].op, op, sizeof(s_ops[0].op));
    s_ops[s_nops].fn = handler;
    s_ops[s_nops].afn = ahandler;
    s_nops++;
    return ESP_OK;
}

esp_err_t okou_op_register(const char *op, okou_op_handler_t handler)
{
    return op_register(op, handler, NULL);
}

esp_err_t okou_op_register_async(const char *op, okou_op_async_handler_t handler)
{
    return op_register(op, NULL, handler);
}

static void txq_push(char *frame)
{
    ensure_queues();
    if (!frame) {
        return;
    }
    if (xQueueSend(s_txq, &frame, 0) != pdTRUE) {
        free(frame);
        s_events_dropped++;
    } else {
        okou_agent_notify();
    }
}

void okou_event_json(const char *name, cJSON *data)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "t", "event");
    cJSON_AddStringToObject(o, "name", name);
    cJSON_AddItemToObject(o, "data", data ? data : cJSON_CreateObject());
    char *s = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    txq_push(s);
}

void okou_event(const char *name, const char *json)
{
    cJSON *data = json ? cJSON_Parse(json) : cJSON_CreateObject();
    if (!cJSON_IsObject(data)) {
        cJSON_Delete(data);
        data = cJSON_CreateObject();
        cJSON_AddStringToObject(data, "text", json);
    }
    okou_event_json(name, data);
}

void okou_metric(const char *name, double value)
{
    uint32_t ms = (uint32_t)(now_us() / 1000);
    portENTER_CRITICAL_SAFE(&s_mmux);
    uint32_t idx;
    if (s_mcount == METRIC_RING) {
        idx = s_mhead;
        s_mhead = (s_mhead + 1) % METRIC_RING;
        s_mdropped++;
    } else {
        idx = (s_mhead + s_mcount) % METRIC_RING;
        s_mcount++;
    }
    strlcpy(s_metrics[idx].name, name, sizeof(s_metrics[idx].name));
    s_metrics[idx].ms = ms;
    s_metrics[idx].v = value;
    portEXIT_CRITICAL_SAFE(&s_mmux);
    okou_agent_notify();
}

/* ------------------------------------------------------------------ hello / status */

#include "okou_install.h"

/* IDF places this directly after esp_app_desc_t in the first image segment.
 * The launcher can check the artifact type and board before erasing a slot. */
#if CONFIG_OKL_URL_OTA
#define OKOU_IMAGE_PROFILE OKOU_BL_IMAGE_PREFIX CONFIG_OKOU_BL_PROFILE
#elif CONFIG_OKOU_MICROPYTHON_RUNTIME
#define OKOU_IMAGE_PROFILE "ESPHUB1/micropython/" CONFIG_OKOU_BOARD_PROFILE
#endif
#ifdef OKOU_IMAGE_PROFILE
static const char image_profile[] __attribute__((section(".rodata_custom_desc"), aligned(4))) = OKOU_IMAGE_PROFILE "\0" OKOU_OTA_CAPABILITY;
#endif

static void hello_fill(cJSON *o)
{
    const esp_app_desc_t *d = esp_app_get_description();
    char sha[65], mac[18];
    okou_hex(d->app_elf_sha256, 32, sha);
    okou_mac_str(mac);
    const esp_partition_t *run = esp_ota_get_running_partition();
    cJSON_AddNumberToObject(o, "proto", 1);
    cJSON_AddBoolToObject(o, "log_flush", true);
#ifdef OKOU_IMAGE_PROFILE
    cJSON_AddStringToObject(o, "image_profile", image_profile);
#if CONFIG_OKL_URL_OTA
    cJSON_AddBoolToObject(o, "dual_launcher_ota",
                         !strcmp(run->label, "launcher_a") || !strcmp(run->label, "launcher_b"));
#endif
    if (CONFIG_OKOU_BL_PROFILE[0]) cJSON_AddStringToObject(o, "bootloader_profile", CONFIG_OKOU_BL_PROFILE);
#endif
#if CONFIG_OKL_URL_OTA
    char board[OKOU_BOARD_CAPACITY];
    if (okou_nvs_get_str(OKOU_BOARD_KEY, board, sizeof(board)) == ESP_OK && board[0])
        cJSON_AddStringToObject(o, "board", board);
#else
    if (CONFIG_OKOU_BOARD_PROFILE[0]) cJSON_AddStringToObject(o, "board", CONFIG_OKOU_BOARD_PROFILE);
#endif
    cJSON_AddStringToObject(o, "boot_id", s_boot_id);
    cJSON_AddStringToObject(o, "role", okou_is_launcher() ? "launcher" : "app");
    cJSON *fw = cJSON_AddObjectToObject(o, "fw");
    cJSON_AddStringToObject(fw, "name", d->project_name);
    cJSON_AddStringToObject(fw, "version", d->version);
    cJSON_AddStringToObject(fw, "idf", d->idf_ver);
    cJSON_AddStringToObject(fw, "sha256", sha);
    cJSON_AddStringToObject(o, "sdk_version", OKOU_SDK_VERSION);
    if (g_okou_cfg.micropython_version)
        cJSON_AddStringToObject(o, "micropython_version", g_okou_cfg.micropython_version);
    const esp_partition_t *launcher = okou_is_launcher() ? run : okou_launcher_partition();
    esp_app_desc_t launcher_desc;
    if (launcher && esp_ota_get_partition_description(launcher, &launcher_desc) == ESP_OK)
        cJSON_AddStringToObject(o, "launcher_version", launcher_desc.version);
    cJSON_AddStringToObject(o, "partition", run ? run->label : "");
    cJSON_AddStringToObject(o, "ota_state", run ? okou_ota_state_str(run) : "");
    cJSON_AddStringToObject(o, "chip", CONFIG_IDF_TARGET);
    cJSON_AddStringToObject(o, "mac", mac);
    cJSON_AddStringToObject(o, "reset_reason", okou_reset_reason_str());
    cJSON_AddBoolToObject(o, "rolled_back", s_rolled_back);
    char *pending = okou_nvs_get_str_alloc(OKOU_KEY_PENDING);
    cJSON *pj = pending ? cJSON_Parse(pending) : NULL;
    free(pending);
    const cJSON *psha = cJSON_GetObjectItemCaseSensitive(pj, "sha256");
    if (cJSON_IsObject(pj)) {
        cJSON *pi = cJSON_AddObjectToObject(o, "pending_install");
        if (cJSON_IsString(psha)) cJSON_AddStringToObject(pi, "sha256", psha->valuestring);
        const cJSON *kind = cJSON_GetObjectItemCaseSensitive(pj, "kind");
        if (cJSON_IsString(kind)) cJSON_AddStringToObject(pi, "kind", kind->valuestring);
        cJSON_AddStringToObject(pi, "state", s_install_state);
    } else {
        cJSON_AddNullToObject(o, "pending_install");
    }
    cJSON_Delete(pj);
    cJSON_AddNumberToObject(o, "heap_free", esp_get_free_heap_size());
    cJSON_AddNumberToObject(o, "heap_internal_free", heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    cJSON_AddNumberToObject(o, "heap_internal_largest",
                            heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    cJSON_AddNumberToObject(o, "uptime_ms", (double)(now_us() / 1000));
}

cJSON *okou_hello_fields(void)
{
    cJSON *o = cJSON_CreateObject();
    hello_fill(o);
    return o;
}

/* ------------------------------------------------------------------ socket */

static bool send_text(const char *s, size_t len)
{
    cJSON *frame = cJSON_ParseWithLength(s, len);
    if (!frame)
        return false;
    const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(frame, "id"));
    const char *t = cJSON_GetStringValue(cJSON_GetObjectItem(frame, "t"));
    const char *name = cJSON_GetStringValue(cJSON_GetObjectItem(frame, "name"));
    bool final = name && (!strcmp(name, "install.done") || !strcmp(name, "install.failed"));
    bool result = t && !strcmp(t, "res");
    bool confirm = result || final || (t && (!strcmp(t, "hello") || !strcmp(t, "log")));
    int64_t seq = -1;
    bool sent = okou_iot_publish(frame, confirm, &seq);
    if (sent && seq >= 0)
        okou_log_ack(seq);
    if (sent && (final || (result && id && !strcmp(id, s_inflight_id)))) {
        s_inflight_id[0] = 0;
    }
    cJSON_Delete(frame);
    if (!sent)
        s_mqtt_broken = true;
    return sent;
}

static void mqtt_teardown(const char *why)
{
    if (s_iot_started) {
        s_inflight_id[0] = 0;
        okou_iot_stop();
        s_iot_started = false;
    }
    if (s_mqtt_up) {
        ESP_LOGW(TAG, "hub connection closed (%s)", why);
    }
#if CONFIG_MBEDTLS_HAVE_TIME_DATE
    /* With certificate date checks on, TLS to the hub fails until the clock is set. The SDK does
     * not start SNTP itself (apps usually own it); say so instead of leaving a bare TLS error. */
    static bool s_time_hint;
    if (!s_mqtt_up && !s_time_hint && time(NULL) < 1704067200 /* 2024-01-01 */) {
        s_time_hint = true;
        ESP_LOGW(TAG, "system time is not set and CONFIG_MBEDTLS_HAVE_TIME_DATE is on: the hub "
                      "certificate cannot be verified until the app starts SNTP");
    }
#endif
    s_mqtt_up = false;
    s_hello_acked = false;
    uint32_t delay = s_backoff_ms * (80 + esp_random() % 41) / 100; /* +-20 % jitter */
    s_next_connect_us = now_us() + (int64_t)delay * US_PER_MS;
    s_backoff_ms = s_backoff_ms * 2 > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : s_backoff_ms * 2;
    ESP_LOGI(TAG, "reconnect in %" PRIu32 " ms", delay);
}

static bool send_hello(void)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "t", "hello");
    hello_fill(o);
    char *s = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    if (s) {
        bool ok = send_text(s, strlen(s));
        free(s);
        return ok;
    }
    return false;
}

/* ------------------------------------------------------------------ flushing */

static void fmt_number(char *b, size_t n, double v)
{
    if (!isfinite(v)) {
        strlcpy(b, "null", n);
    } else {
        snprintf(b, n, "%.9g", v);
    }
}

static void flush_metrics(void)
{
    size_t cap = CONFIG_OKOU_TX_FRAME_MAX;
    size_t pos = 0;
    int count = 0;
    for (;;) {
        metric_t m;
        bool have = false;
        portENTER_CRITICAL(&s_mmux);
        if (s_mcount) {
            m = s_metrics[s_mhead];
            s_mhead = (s_mhead + 1) % METRIC_RING;
            s_mcount--;
            have = true;
        }
        portEXIT_CRITICAL(&s_mmux);
        if (have) {
            if (count == 0) {
                pos = (size_t)snprintf(s_txbuf, cap, "{\"t\":\"metric\",\"items\":[");
            }
            char num[32];
            fmt_number(num, sizeof(num), m.v);
            if (count) {
                s_txbuf[pos++] = ',';
            }
            s_txbuf[pos++] = '[';
            s_txbuf[pos++] = '"';
            int e = okou_json_escape(s_txbuf + pos, cap - pos - 64, m.name, strnlen(m.name, sizeof(m.name)));
            pos += e > 0 ? (size_t)e : 0;
            pos += (size_t)snprintf(s_txbuf + pos, cap - pos, "\",%" PRIu32 ",%s]", m.ms, num);
            count++;
        }
        if ((!have || pos + 128 > cap) && count) {
            s_txbuf[pos++] = ']';
            s_txbuf[pos++] = '}';
            s_txbuf[pos] = '\0';
            send_text(s_txbuf, pos);
            count = 0;
            pos = 0;
        }
        if (!have) {
            break;
        }
    }
}

static void drain_txq(void)
{
    char *s;
    while (xQueueReceive(s_txq, &s, 0) == pdTRUE) {
        bool ok = send_text(s, strlen(s));
        free(s);
        if (!ok) {
            break; /* dropped; the socket is going down */
        }
    }
}

/* ------------------------------------------------------------------ requests */

static void send_res(const cJSON *id, bool ok, cJSON *data, const char *err)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "t", "res");
    cJSON_AddItemToObject(o, "id", id ? cJSON_Duplicate(id, true) : cJSON_CreateNull());
    cJSON_AddBoolToObject(o, "ok", ok);
    if (ok) {
        cJSON_AddItemToObject(o, "data", data ? data : cJSON_CreateObject());
    } else {
        cJSON_Delete(data);
        cJSON_AddStringToObject(o, "error", err && *err ? err : "error");
    }
    char *s = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    if (s && strlen(s) > 16384) {
        free(s);
        send_res(id, false, NULL, "response exceeds 16 KiB");
        return;
    }
    if (s) {
        send_text(s, strlen(s));
        free(s);
    }
}

// Drain a finite snapshot one frame per agent iteration. A recall may extend
// an existing batch; urgent events, commands and scheduled reboots still run.
static void service_mqtt_log_batch(int64_t now)
{
    if (s_mqtt_broken)
        return;
    if (!s_log_request_id && !s_log_batch_through && now < s_next_log_batch_us) return;

    okou_log_stats_t stats = okou_log_stats();
    if (!s_log_batch_through && !s_log_request_id) {
        s_log_batch_through = stats.last_written;
        s_next_log_batch_us = now + MQTT_LOG_INTERVAL_US;
    }
    if (stats.last_acked < s_log_batch_through) {
        size_t n = okou_log_build_frame(s_txbuf, CONFIG_OKOU_TX_FRAME_MAX, s_log_batch_through);
        if (!n || !send_text(s_txbuf, n)) {
            s_mqtt_broken = true;
            return;
        }
        stats = okou_log_stats();
        if (stats.last_acked != stats.last_sent) {
            // Reconnect and replay from the acknowledged cursor.
            s_mqtt_broken = true;
            return;
        }
        if (stats.last_acked < s_log_batch_through) return;
    }

    s_log_batch_through = 0;
    if (s_log_request_id) {
        cJSON *data = cJSON_CreateObject();
        bool ok = data && cJSON_AddNumberToObject(data, "last_acked_seq", stats.last_acked) &&
                  cJSON_AddNumberToObject(data, "dropped_lines", stats.dropped);
        send_res(s_log_request_id, ok, data, "Cannot allocate log receipt");
        cJSON_Delete(s_log_request_id);
        s_log_request_id = NULL;
    }
}

static char *build_res_string(const cJSON *id, bool ok, cJSON *data, const char *err)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "t", "res");
    cJSON_AddItemToObject(o, "id", id ? cJSON_Duplicate(id, true) : cJSON_CreateNull());
    cJSON_AddBoolToObject(o, "ok", ok);
    if (ok) {
        cJSON_AddItemToObject(o, "data", data ? data : cJSON_CreateObject());
    } else {
        cJSON_Delete(data);
        cJSON_AddStringToObject(o, "error", err && *err ? err : "error");
    }
    char *s = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    return s;
}

void okou_op_reply(okou_req_t *req, bool ok, cJSON *data, const char *err)
{
    if (!req) {
        cJSON_Delete(data);
        return;
    }
    char *s = build_res_string(req->id, ok, data, err);
    cJSON_Delete(req->id);
    free(req);
    if (s && strlen(s) > 16384) {
        free(s);
        s = NULL;
    }
    txq_push(s); /* sent by the agent task; dropped if the hub is not connected */
}

static esp_err_t run_cmd(const char *name, const cJSON *argv, cJSON *data, char *err, size_t errlen)
{
    char *out = NULL;
    int rc = okou_cmd_run(name, argv, &out);
    if (rc == -1000) {
        snprintf(err, errlen, "unknown command: %s", name);
        return ESP_ERR_NOT_FOUND;
    }
    if (rc != 0) {
        if (out && *out) {
            strlcpy(err, out, errlen);
        } else {
            snprintf(err, errlen, "exit %d", rc);
        }
        free(out);
        return ESP_FAIL;
    }
    cJSON_AddStringToObject(data, "output", out ? out : "");
    free(out);
    return ESP_OK;
}

static esp_err_t op_reboot(const cJSON *args, cJSON *data, char *err, size_t errlen)
{
    const cJSON *jt = cJSON_GetObjectItemCaseSensitive(args, "target");
    const char *target = cJSON_IsString(jt) ? jt->valuestring : "self";
    bool launcher = okou_is_launcher();
    if (strcmp(target, "app") == 0) {
        if (launcher) {
            const esp_partition_t *app = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY,
                                                                  "app");
            esp_err_t e = app ? esp_ota_set_boot_partition(app) : ESP_ERR_NOT_FOUND;
            if (e != ESP_OK) {
                snprintf(err, errlen, "no bootable app image: %s", esp_err_to_name(e));
                return e;
            }
            okou_nvs_set_u8(OKOU_KEY_FAIL_BOOTS, 0);
            okou_nvs_erase(OKOU_KEY_HOLD);
        }
    } else if (strcmp(target, "launcher") == 0) {
        if (!launcher) {
            const esp_partition_t *lp = okou_launcher_partition();
            esp_err_t e = lp ? esp_ota_set_boot_partition(lp) : ESP_ERR_NOT_FOUND;
            if (e != ESP_OK) {
                snprintf(err, errlen, "cannot select launcher: %s", esp_err_to_name(e));
                return e;
            }
        }
        okou_nvs_set_u8(OKOU_KEY_HOLD, 1);
    } else if (strcmp(target, "self") == 0) {
        if (launcher) {
            okou_nvs_set_u8(OKOU_KEY_HOLD, 1);
        }
    } else {
        snprintf(err, errlen, "bad target: %s", target);
        return ESP_ERR_INVALID_ARG;
    }
    ESP_LOGW(TAG, "reboot requested (target=%s)", target);
    okou_schedule_reboot(300);
    return ESP_OK;
}

static void handle_req(const cJSON *root)
{
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(root, "id");
    const cJSON *jop = cJSON_GetObjectItemCaseSensitive(root, "op");
    const cJSON *args = cJSON_GetObjectItemCaseSensitive(root, "args");
    const char *op = cJSON_IsString(jop) ? jop->valuestring : "";
    if (s_hooks.on_request && strcmp(op, "logs.flush") != 0) {
        s_hooks.on_request(op);
    }
    cJSON *data = cJSON_CreateObject();
    char err[192] = "";
    esp_err_t r = ESP_ERR_NOT_SUPPORTED;
    for (int i = 0; i < s_nops; i++) {
        if (strcmp(s_ops[i].op, op) == 0) {
            if (s_ops[i].afn) {
                okou_req_t *req = calloc(1, sizeof(*req));
                if (req) {
                    req->id = id ? cJSON_Duplicate(id, true) : cJSON_CreateNull();
                }
                r = req && req->id ? s_ops[i].afn(req, args, err, sizeof(err)) : ESP_ERR_NO_MEM;
                if (r == ESP_OK) {
                    cJSON_Delete(data); /* answered later through okou_op_reply() */
                    return;
                }
                if (req) {
                    cJSON_Delete(req->id);
                    free(req);
                }
                if (!err[0] && r == ESP_ERR_NO_MEM) {
                    snprintf(err, sizeof(err), "out of memory");
                }
                send_res(id, false, data, err);
                return;
            }
            r = s_ops[i].fn(args, data, err, sizeof(err));
            if (r == ESP_OK && !strcmp(op, "install"))
                cJSON_Delete(data);
            else
                send_res(id, r == ESP_OK, data, err);
            return;
        }
    }
    if (strcmp(op, "logs.flush") == 0) {
        s_log_request_id = cJSON_Duplicate(id, false);
        if (s_log_request_id) {
            s_log_batch_through = okou_log_stats().last_written;
            s_next_log_batch_us = now_us() + MQTT_LOG_INTERVAL_US;
            cJSON_Delete(data);
            return; // Respond after the captured sequence has been acknowledged.
        }
        r = ESP_ERR_NO_MEM;
        snprintf(err, sizeof(err), "Cannot allocate log receipt");
    } else if (strcmp(op, "status") == 0) {
        hello_fill(data);
        okou_net_info(data);
        cJSON_AddItemToObject(data, "partitions", okou_partitions_json());
        r = ESP_OK;
    } else if (strcmp(op, "cmd") == 0) {
        const cJSON *n = cJSON_GetObjectItemCaseSensitive(args, "name");
        const cJSON *argv = cJSON_GetObjectItemCaseSensitive(args, "argv");
        if (!cJSON_IsString(n)) {
            snprintf(err, sizeof(err), "missing name");
            r = ESP_ERR_INVALID_ARG;
        } else if (g_okou_cfg.handlers_in_poll) {
            poll_job_t *j = calloc(1, sizeof(*j));
            if (j) {
                j->id = cJSON_Duplicate(id, true);
                strlcpy(j->name, n->valuestring, sizeof(j->name));
                j->argv = argv ? cJSON_Duplicate(argv, true) : NULL;
            }
            if (j && xQueueSend(s_pollq, &j, 0) == pdTRUE) {
                cJSON_Delete(data);
                return; /* answered from okou_poll() */
            }
            if (j) {
                cJSON_Delete(j->id);
                cJSON_Delete(j->argv);
                free(j);
            }
            snprintf(err, sizeof(err), "busy: app has not polled");
            r = ESP_ERR_NO_MEM;
        } else {
            r = run_cmd(n->valuestring, argv, data, err, sizeof(err));
        }
    } else if (strcmp(op, "cmd.list") == 0) {
        cJSON_AddItemToObject(data, "commands", okou_cmd_list_json());
        r = ESP_OK;
    } else if (strcmp(op, "param.list") == 0) {
        cJSON_AddItemToObject(data, "params", okou_param_list_json());
        r = ESP_OK;
    } else if (strcmp(op, "param.get") == 0) {
        const cJSON *n = cJSON_GetObjectItemCaseSensitive(args, "name");
        r = okou_param_get_json(cJSON_IsString(n) ? n->valuestring : NULL, data, err, sizeof(err));
    } else if (strcmp(op, "param.set") == 0) {
        r = okou_param_set_json(args, data, err, sizeof(err));
    } else if (strcmp(op, "provision.reset") == 0) {
        const char *keys[] = {"mqtt_identity", "ble_key", "ssid", "pass", "cid", "csec", "hub", OKOU_KEY_TOKEN};
        r = okou_nvs_set_str(OKOU_KEY_WIFIS, "[]");
        for (size_t i = 0; r == ESP_OK && i < sizeof(keys)/sizeof(keys[0]); ++i) {
            r = okou_nvs_erase(keys[i]);
        }
        if (r == ESP_OK && !okou_is_launcher()) {
            const esp_partition_t *lp = okou_launcher_partition();
            r = lp ? esp_ota_set_boot_partition(lp) : ESP_ERR_NOT_FOUND;
        }
        if (r == ESP_OK) {
            okou_nvs_set_u8(OKOU_KEY_SETUP, 1);
            okou_schedule_reboot(500);
        }
        if (r != ESP_OK) snprintf(err, sizeof(err), "reset failed: %s", esp_err_to_name(r));
    } else if (strcmp(op, "reboot") == 0) {
        r = op_reboot(args, data, err, sizeof(err));
    } else if (strcmp(op, "install") == 0 && !okou_is_launcher()) {
        snprintf(err, sizeof(err), "Enter launcher mode before OTA");
    } else {
        snprintf(err, sizeof(err), "unknown op: %s", op);
    }
    if (r == ESP_OK && !strcmp(op, "reboot"))
        cJSON_Delete(data);
    else
        send_res(id, r == ESP_OK, data, err);
}

int okou_poll(uint32_t timeout_ms)
{
    ensure_queues();
    int n = 0;
    poll_job_t *j;
    while (xQueueReceive(s_pollq, &j, n == 0 ? pdMS_TO_TICKS(timeout_ms) : 0) == pdTRUE) {
        cJSON *data = cJSON_CreateObject();
        char err[192] = "";
        esp_err_t r = run_cmd(j->name, j->argv, data, err, sizeof(err));
        txq_push(build_res_string(j->id, r == ESP_OK, data, err));
        cJSON_Delete(j->id);
        cJSON_Delete(j->argv);
        free(j);
        n++;
    }
    return n;
}

/* Rollback visibility. The bootloader's "last invalid partition" survives only until the next
 * esp_ota_set_boot_partition() rewrites otadata (the launcher auto-starting the app does exactly
 * that, usually before it has reached the hub). So record it in NVS on the first boot that sees
 * it, and report it as a `rollback` event from whichever role reaches the hub first. */
static void record_rollback(void)
{
    const esp_partition_t *inv = esp_ota_get_last_invalid_partition();
    char last[17] = "";
    okou_nvs_get_str(OKOU_KEY_RB_LAST, last, sizeof(last));
    if (!inv) {
        if (last[0]) {
            okou_nvs_erase(OKOU_KEY_RB_LAST); /* otadata moved on; a later rollback is new */
        }
        return;
    }
    if (strcmp(last, inv->label) == 0) {
        return; /* same rollback, already recorded */
    }
    const esp_partition_t *run = esp_ota_get_running_partition();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "partition", inv->label);
    cJSON_AddStringToObject(o, "kind", strcmp(inv->label, "app") == 0 ? "app" : "launcher");
    cJSON_AddStringToObject(o, "returned_to", run ? run->label : "?");
    cJSON_AddStringToObject(o, "reset_reason", okou_reset_reason_str());
    cJSON_AddStringToObject(o, "detected_by", okou_is_launcher() ? "launcher" : "app");
    cJSON_AddStringToObject(o, "boot_id", s_boot_id);
    char *js = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    if (js) {
        okou_nvs_set_str(OKOU_KEY_RB, js);
        okou_nvs_set_str(OKOU_KEY_RB_LAST, inv->label);
        ESP_LOGW(TAG, "rollback detected: %s was invalidated, running %s", inv->label, run ? run->label : "?");
        free(js);
    }
}

static void report_rollback(void)
{
    char *js = okou_nvs_get_str_alloc(OKOU_KEY_RB);
    if (!js) {
        return;
    }
    cJSON *d = cJSON_Parse(js);
    free(js);
    if (d) {
        okou_event_json("rollback", d); /* takes ownership */
    }
    okou_nvs_erase(OKOU_KEY_RB);
}

esp_err_t okou_enter_setup(void)
{
    const esp_partition_t *lp = okou_launcher_partition();
    if (!lp) {
        return ESP_ERR_NOT_FOUND;
    }
    okou_nvs_set_u8(OKOU_KEY_SETUP, 1);
    esp_err_t e = esp_ota_set_boot_partition(lp);
    if (e != ESP_OK) {
        return e;
    }
    ESP_LOGW(TAG, "entering setup: rebooting into %s for provisioning", lp->label);
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_restart();
    return ESP_OK;
}

esp_err_t okou_app_mark_valid(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    esp_err_t e = run ? esp_ota_get_state_partition(run, &st) : ESP_ERR_NOT_FOUND;
    if (e != ESP_OK) {
        return e == ESP_ERR_NOT_FOUND ? ESP_OK : e; /* no otadata entry (USB flash): nothing to confirm */
    }
    if (st != ESP_OTA_IMG_PENDING_VERIFY) {
        return st == ESP_OTA_IMG_VALID ? ESP_OK : ESP_ERR_INVALID_STATE;
    }
    e = esp_ota_mark_app_valid_cancel_rollback();
    if (e == ESP_OK) {
        ESP_LOGI(TAG, "app marked valid by its own health check (rollback cancelled)");
        cJSON *d = cJSON_CreateObject();
        cJSON_AddStringToObject(d, "partition", run->label);
        cJSON_AddStringToObject(d, "by", "app");
        okou_event_json("app.valid", d); /* queued; delivered once the hub is reachable */
    }
    return e;
}

static void on_first_ack(void)
{
    ESP_LOGI(TAG, "hello acknowledged by hub");
    report_rollback();
    if (!okou_is_launcher() && !g_okou_cfg.app_validates) {
        const esp_partition_t *run = esp_ota_get_running_partition();
        esp_ota_img_states_t st;
        if (esp_ota_get_state_partition(run, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY) {
            if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
                ESP_LOGI(TAG, "app marked valid (rollback cancelled)");
                cJSON *d = cJSON_CreateObject();
                cJSON_AddStringToObject(d, "partition", run->label);
                cJSON_AddStringToObject(d, "by", "hub_ack");
                okou_event_json("app.valid", d);
            }
        }
        okou_nvs_set_u8(OKOU_KEY_FAIL_BOOTS, 0);
    }
    if (s_hooks.on_hello_acked) {
        s_hooks.on_hello_acked();
    }
}

static void do_reboot(void)
{
    ESP_LOGW(TAG, "rebooting");
    if (s_mqtt_up && !s_mqtt_broken) {
        drain_txq();
        s_log_batch_through = okou_log_stats().last_written;
        service_mqtt_log_batch(now_us());
    }
    esp_restart();
}

static void pull_commands(void)
{
    cJSON *body = cJSON_CreateObject();
    if (!body)
        return;
    cJSON_AddStringToObject(body, "boot_id", s_boot_id);
    cJSON *batch = okou_iot_post("iot/pull", body);
    const cJSON *commands = cJSON_GetObjectItemCaseSensitive(batch, "commands");
    if (!cJSON_IsArray(commands))
        s_mqtt_broken = true;
    const cJSON *command = cJSON_GetArrayItem(commands, 0);
    const char *id = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(command, "id"));
    if (id) {
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(command, "more"))) s_pull_due = true;
        strlcpy(s_inflight_id, id, sizeof(s_inflight_id));
        s_inflight_until = now_us() + 90000000;
        handle_req(command);
    }
    cJSON_Delete(batch);
    cJSON_Delete(body);
}

#if CONFIG_OKOU_BLE_WIFI
static void sync_ble_when_online(int64_t now)
{
    static int64_t retry_at;
    if (!s_cfg_ok || !okou_net_has_ip() || okou_ble_busy()) {
        s_ble_sync_needed = true;
        retry_at = 0;
        return;
    }
    if (!s_ble_sync_needed || now < retry_at)
        return;
    unsigned generation = okou_ble_generation();
    if (!generation) {
        s_ble_sync_needed = false;
        return;
    }
    cJSON *body = cJSON_CreateObject();
    cJSON_AddNumberToObject(body, "generation", generation);
    cJSON *reply = okou_iot_post("ble/sync", body);
    cJSON_Delete(body);
    retry_at = now + 30000000;
    if (!reply)
        return;
    const cJSON *next = cJSON_GetObjectItemCaseSensitive(reply, "generation");
    if (!next)
        s_ble_sync_needed = false;
    else {
        const char *secret = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(reply, "secret"));
        if (cJSON_IsNumber(next) && secret && okou_ble_install(next->valueint, secret, false) == ESP_OK)
            retry_at = 0;
    }
    cJSON_Delete(reply);
}
#endif

static void agent_task(void *arg)
{
    for (;;) {
        int64_t now = now_us();
        if (s_reload) {
            s_reload = false;
            s_cfg_ok = load_config();
#if CONFIG_OKOU_BLE_WIFI
            s_ble_sync_needed = true;
#endif
            if (s_iot_started) {
                mqtt_teardown("config reload");
            }
            s_backoff_ms = 1000;
            s_next_connect_us = now;
        }
#if CONFIG_OKOU_BLE_WIFI
        sync_ble_when_online(now);
#endif
        if (s_mqtt_broken && s_iot_started) {
            mqtt_teardown("send failed");
        }
        if (s_iot_started) {
            unsigned events = okou_iot_events();
            if (events & IOT_OFFLINE)
                mqtt_teardown("MQTT disconnected");
            else if (events & IOT_SUBSCRIBED) {
                s_up_since_us = now;
                s_mqtt_up = true;
                okou_log_rewind();
                if (send_hello()) {
                    s_hello_acked = true;
                    on_first_ack();
                } else {
                    s_mqtt_broken = true;
                }
            }
            if (events & IOT_WAKE)
                s_pull_due = true;
        }
        if (!s_iot_started) {
            if (s_cfg_ok && okou_net_has_ip() && now >= s_next_connect_us) {
                s_mqtt_broken = false;
                s_conn_start_us = now;
                s_iot_started = okou_iot_start(s_boot_id);
                if (!s_iot_started)
                    mqtt_teardown("MQTT setup failed");
            }
        } else if (!s_mqtt_up) {
            if (now - s_conn_start_us > CONNECT_TIMEOUT_US) {
                mqtt_teardown("connect timeout");
            }
        } else {
            drain_txq();
            if (s_hello_acked && s_hooks.on_connected_poll)
                s_hooks.on_connected_poll(s_boot_id);
            if (s_pull_due && !s_log_request_id && s_hello_acked &&
                (!s_inflight_id[0] || now >= s_inflight_until)) {
                s_pull_due = false;
                pull_commands();
            }
            service_mqtt_log_batch(now);
            if (now - s_last_flush_us >= FLUSH_INTERVAL_US) {
                s_last_flush_us = now;
                flush_metrics();
            }
            if (!okou_net_has_ip()) {
                mqtt_teardown("network down");
            } else if (now - s_up_since_us >= BACKOFF_RESET_US) {
                s_backoff_ms = 1000;
            }
        }
        portENTER_CRITICAL(&s_rmux);
        int64_t rb = s_reboot_at_us;
        portEXIT_CRITICAL(&s_rmux);
        if (rb && now >= rb) do_reboot();

        // Housekeeping is bounded to one second. Transport and producer callbacks
        // wake us immediately. Keep shorter deadlines for batching and delayed reboot.
        now = now_us();
        int64_t deadline = now + 1000000;
        if (rb && rb < deadline) deadline = rb;
        if (s_mqtt_up) {
            portENTER_CRITICAL(&s_mmux);
            bool metrics = s_mcount != 0;
            portEXIT_CRITICAL(&s_mmux);
            if (s_log_batch_through && !s_mqtt_broken)
                deadline = now;
            if (metrics && s_last_flush_us + FLUSH_INTERVAL_US < deadline)
                deadline = s_last_flush_us + FLUSH_INTERVAL_US;
        }
        if (deadline > now)
            xSemaphoreTake(s_wake, pdMS_TO_TICKS((deadline - now) / 1000) + 1);
    }
}

#if CONFIG_OKL_URL_OTA || CONFIG_OKOU_MICROPYTHON_RUNTIME
#include "esp_netif_sntp.h"
static void sntp_task(void *arg)
{
    /* Validate TLS certificate dates after a cold boot. */
    while (!okou_net_has_ip()) {
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    esp_sntp_config_t c = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_err_t e = esp_netif_sntp_init(&c);
    if (e != ESP_OK) {
        ESP_LOGW(TAG, "SNTP start failed: %s", esp_err_to_name(e));
    }
    vTaskDelete(NULL);
}

#endif

esp_err_t okou_agent_start(const okou_config_t *cfg)
{
    if (s_started) {
        return ESP_ERR_INVALID_STATE;
    }
    s_started = true;
    if (cfg) {
        g_okou_cfg = *cfg;
    }
    s_wake = xSemaphoreCreateBinary();
    if (!s_wake) return ESP_ERR_NO_MEM;
#if CONFIG_PM_ENABLE
    esp_pm_config_t pm = {
        .max_freq_mhz = CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ,
        .min_freq_mhz = CONFIG_XTAL_FREQ,
        .light_sleep_enable = true,
    };
    esp_err_t pm_err = esp_pm_configure(&pm);
    if (pm_err != ESP_OK) ESP_LOGW(TAG, "Power management unavailable: %s", esp_err_to_name(pm_err));
#endif
    esp_err_t e = okou_log_init();
    if (e != ESP_OK) {
        return e;
    }
    e = okou_nvs_init();
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "nvs init: %s", esp_err_to_name(e));
        return e;
    }
    ensure_queues();
    for (int i = 0; i < 4; ++i) {
        snprintf(s_boot_id + 8*i, 9, "%08" PRIx32, esp_random());
    }
    s_rolled_back = esp_ota_get_last_invalid_partition() != NULL;
    record_rollback();

    if (!okou_is_launcher() && !g_okou_cfg.app_validates && CONFIG_OKOU_MAX_FAIL_BOOTS > 0) {
        uint8_t fb = okou_nvs_get_u8(OKOU_KEY_FAIL_BOOTS, 0);
        if (fb >= CONFIG_OKOU_MAX_FAIL_BOOTS) {
            const esp_partition_t *lp = okou_launcher_partition();
            ESP_LOGE(TAG, "fail_boots=%u without hub ack: booting launcher (%s)", fb, lp ? lp->label : "none");
            if (lp && esp_ota_set_boot_partition(lp) == ESP_OK) {
                vTaskDelay(pdMS_TO_TICKS(100));
                esp_restart();
            }
        }
        okou_nvs_set_u8(OKOU_KEY_FAIL_BOOTS, fb < 255 ? fb + 1 : fb);
    }

    okou_registry_builtin_cmds();
    s_txbuf = okou_malloc_large(CONFIG_OKOU_TX_FRAME_MAX + 1);
    if (!s_txbuf) {
        return ESP_ERR_NO_MEM;
    }
    s_cfg_ok = load_config();
    e = okou_net_start(g_okou_cfg.manage_network);
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "network start: %s", esp_err_to_name(e));
    }
#if CONFIG_OKOU_BLE_WIFI
    okou_ble_start();
#endif
    const esp_app_desc_t *d = esp_app_get_description();
    ESP_LOGI(TAG, "agent start: %s %s role=%s boot_id=%s", d->project_name, d->version,
             okou_is_launcher() ? "launcher" : "app", s_boot_id);
    if (xTaskCreate(agent_task, "okou_agent", CONFIG_OKOU_TASK_STACK, NULL, CONFIG_OKOU_TASK_PRIO, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
#if CONFIG_OKL_URL_OTA || CONFIG_OKOU_MICROPYTHON_RUNTIME
    xTaskCreate(sntp_task, "okl_sntp", 3072, NULL, 3, NULL);
#endif
    return ESP_OK;
}
