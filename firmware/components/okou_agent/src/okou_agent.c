/*
 * okou agent core: hub connection, framing and request dispatch (docs/protocol.md v1).
 *
 * Threads:
 *  - esp_websocket_client task: only copies received text frames into s_rxq (never blocks).
 *  - agent task (low priority): the only writer to the socket. Sends hello, batches logs and
 *    metrics every 200 ms, drains s_txq (events/async responses), keep-alive, reconnects.
 *  - any task: okou_metric/okou_event/ESP_LOG only touch bounded buffers with timeout 0.
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
#include "esp_random.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "esp_idf_version.h"
#include "esp_ota_ops.h"
#include "esp_crt_bundle.h"
#include "esp_websocket_client.h"
#include "esp_heap_caps.h"
#include "driver/gpio.h"
#include "sdkconfig.h"
#include "okou_priv.h"

#define TAG OKOU_TAG
#define US_PER_MS 1000LL
#define PING_INTERVAL_US (30 * 1000000LL)
#define PONG_TIMEOUT_US (90 * 1000000LL)
#define BACKOFF_RESET_US (60 * 1000000LL)
#define CONNECT_TIMEOUT_US (30 * 1000000LL)
#define FLUSH_INTERVAL_US (200 * 1000LL)
#define BACKOFF_MAX_MS 60000
#define RX_FRAME_MAX 8192
#define METRIC_RING 32
#define MAX_OPS 8

okou_config_t g_okou_cfg = OKOU_CONFIG_DEFAULT();

typedef enum { M_CONNECTED, M_DISCONNECTED, M_TEXT } mtype_t;
typedef struct {
    uint8_t type;
    uint32_t gen;
    char *data;
    size_t len;
} msg_t;

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

static QueueHandle_t s_rxq, s_txq, s_pollq;
static esp_websocket_client_handle_t s_ws;
static volatile uint32_t s_gen;
static volatile bool s_ws_up, s_hello_acked, s_ws_broken, s_reload;
static int64_t s_conn_start_us, s_up_since_us, s_last_rx_us, s_last_ping_us, s_last_flush_us, s_next_connect_us;
static uint32_t s_backoff_ms = 1000;
static volatile int64_t s_reboot_at_us;
static char s_boot_id[33];
static uint32_t uart_cursor;
static int64_t last_uart_poll;
static bool s_rolled_back;
static char *s_txbuf;
static okou_hooks_t s_hooks;
static char s_install_state[20] = "queued";
static bool s_started, s_cfg_ok, s_dev;
static char s_hub[100], s_cid[96], s_csec[100], s_tok[96], s_url[180];
static char s_headers[256];
static op_t s_ops[MAX_OPS];
static int s_nops;
static uint32_t s_events_dropped;

/* receive reassembly - websocket task only */
static char *s_rx_acc;
static size_t s_rx_acc_cap;
static bool s_rx_skip;

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
    QueueHandle_t rx = xQueueCreate(8, sizeof(msg_t));
    QueueHandle_t tx = xQueueCreate(16, sizeof(char *));
    QueueHandle_t pq = xQueueCreate(4, sizeof(poll_job_t *));
    portENTER_CRITICAL(&m);
    if (!done) {
        s_rxq = rx;
        s_txq = tx;
        s_pollq = pq;
        done = true;
        rx = tx = pq = NULL;
    }
    portEXIT_CRITICAL(&m);
    if (rx) {
        vQueueDelete(rx);
        vQueueDelete(tx);
        vQueueDelete(pq);
    }
}

/* ------------------------------------------------------------------ config */

static bool starts_with(const char *s, const char *p)
{
    return strncmp(s, p, strlen(p)) == 0;
}

static bool load_config(void)
{
    s_hub[0] = s_cid[0] = s_csec[0] = s_tok[0] = '\0';
    okou_nvs_get_str("hub", s_hub, sizeof(s_hub));
    okou_nvs_get_str("cid", s_cid, sizeof(s_cid));
    okou_nvs_get_str("csec", s_csec, sizeof(s_csec));
    okou_nvs_get_str(OKOU_KEY_TOKEN, s_tok, sizeof(s_tok));
    if (!s_hub[0]) {
        ESP_LOGW(TAG, "not provisioned: okl/hub missing");
        return false;
    }
    /* A hub device token (okl/tok) uses the /api/device/ endpoints with a bearer header; otherwise
     * the legacy Cloudflare Access service token on /device/. */
    const char *connect_path = s_tok[0] ? "/api/device/connect" : "/device/connect";
    if (starts_with(s_hub, "ws://") || starts_with(s_hub, "wss://")) {
        s_dev = starts_with(s_hub, "ws://");
        const char *host = strstr(s_hub, "://") + 3;
        const char *path = strchr(host, '/');
        if (!path || path[1] == '\0') {
            int hl = path ? (int)(path - s_hub) : (int)strlen(s_hub);
            snprintf(s_url, sizeof(s_url), "%.*s%s", hl, s_hub, connect_path);
        } else {
            strlcpy(s_url, s_hub, sizeof(s_url));
        }
    } else {
        s_dev = false;
        snprintf(s_url, sizeof(s_url), "wss://%s%s", s_hub, connect_path);
    }
    if (s_tok[0]) {
        snprintf(s_headers, sizeof(s_headers), "Authorization: Bearer %s\r\n", s_tok);
    } else if (s_dev) {
        if (!s_cid[0]) {
            ESP_LOGW(TAG, "not provisioned: okl/cid missing");
            return false;
        }
        snprintf(s_headers, sizeof(s_headers), "X-Dev-Client-Id: %s\r\n", s_cid);
    } else {
        if (!s_cid[0] || !s_csec[0]) {
            ESP_LOGW(TAG, "not provisioned: okl/cid or okl/csec missing");
            return false;
        }
        snprintf(s_headers, sizeof(s_headers), "CF-Access-Client-Id: %s\r\nCF-Access-Client-Secret: %s\r\n", s_cid,
                 s_csec);
    }
    ESP_LOGI(TAG, "hub %s (%s)", s_url, s_tok[0] ? "device token" : s_dev ? "dev, X-Dev-Client-Id" : "Cloudflare Access");
    return true;
}

esp_err_t okou_hub_http_base(char *buf, size_t len)
{
    if (!s_hub[0]) {
        return ESP_ERR_INVALID_STATE;
    }
    if (starts_with(s_hub, "ws://") || starts_with(s_hub, "wss://")) {
        const char *host = strstr(s_hub, "://") + 3;
        const char *path = strchr(host, '/');
        int hl = path ? (int)(path - host) : (int)strlen(host);
        snprintf(buf, len, "%s://%.*s", s_dev ? "http" : "https", hl, host);
    } else {
        snprintf(buf, len, "https://%s", s_hub);
    }
    return ESP_OK;
}

void okou_http_apply_auth(esp_http_client_handle_t client)
{
    if (s_tok[0]) {
        char h[sizeof(s_tok) + 8];
        snprintf(h, sizeof(h), "Bearer %s", s_tok);
        esp_http_client_set_header(client, "Authorization", h);
    } else if (s_dev) {
        esp_http_client_set_header(client, "X-Dev-Client-Id", s_cid);
    } else {
        esp_http_client_set_header(client, "CF-Access-Client-Id", s_cid);
        esp_http_client_set_header(client, "CF-Access-Client-Secret", s_csec);
    }
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

bool okou_connected(void)
{
    return s_ws_up && s_hello_acked;
}

bool okou_ws_connected(void)
{
    return s_ws_up;
}

void okou_agent_reload_config(void)
{
    s_reload = true;
}

void okou_schedule_reboot(uint32_t delay_ms)
{
    int64_t t = now_us() + (int64_t)delay_ms * US_PER_MS;
    portENTER_CRITICAL(&s_rmux);
    s_reboot_at_us = t;
    portEXIT_CRITICAL(&s_rmux);
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
}

/* ------------------------------------------------------------------ hello / status */

/* IDF places this directly after esp_app_desc_t in the first image segment.
 * The launcher can check the artifact type and board before erasing a slot. */
#if CONFIG_OKL_URL_OTA
#if CONFIG_OKL_BOARD_M5_STOPWATCH
#define OKOU_IMAGE_PROFILE "ESPHUB1/launcher/stopwatch"
#else
#define OKOU_IMAGE_PROFILE "ESPHUB1/launcher/paper-color"
#endif
#elif CONFIG_OKOU_MICROPYTHON_RUNTIME
#define OKOU_IMAGE_PROFILE "ESPHUB1/micropython/" CONFIG_OKOU_BOARD_PROFILE
#endif
#ifdef OKOU_IMAGE_PROFILE
static const char image_profile[] __attribute__((section(".rodata_custom_desc"), aligned(4))) = OKOU_IMAGE_PROFILE;
#endif

static void hello_fill(cJSON *o)
{
    const esp_app_desc_t *d = esp_app_get_description();
    char sha[65], mac[18];
    okou_hex(d->app_elf_sha256, 32, sha);
    okou_mac_str(mac);
    const esp_partition_t *run = esp_ota_get_running_partition();
    cJSON_AddNumberToObject(o, "proto", 1);
#ifdef OKOU_IMAGE_PROFILE
    cJSON_AddStringToObject(o, "image_profile", image_profile);
#endif
#if CONFIG_OKL_BOARD_M5_STOPWATCH
    cJSON_AddStringToObject(o, "board", "stopwatch");
#elif CONFIG_OKL_BOARD_GENERIC && CONFIG_IDF_TARGET_ESP32S3
    cJSON_AddStringToObject(o, "board", "paper-color");
#else
    if (CONFIG_OKOU_BOARD_PROFILE[0]) cJSON_AddStringToObject(o, "board", CONFIG_OKOU_BOARD_PROFILE);
#endif
    cJSON_AddStringToObject(o, "boot_id", s_boot_id);
    cJSON_AddStringToObject(o, "role", g_okou_cfg.role == OKOU_ROLE_LAUNCHER ? "launcher" : "app");
    cJSON *fw = cJSON_AddObjectToObject(o, "fw");
    cJSON_AddStringToObject(fw, "name", d->project_name);
    cJSON_AddStringToObject(fw, "version", d->version);
    cJSON_AddStringToObject(fw, "idf", d->idf_ver);
    cJSON_AddStringToObject(fw, "sha256", sha);
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
    if (!s_ws || !s_ws_up || s_ws_broken) {
        return false;
    }
    if (len > 16384) {
        ESP_LOGE(TAG, "frame too large (%u), dropped", (unsigned)len);
        return true;
    }
    int r = esp_websocket_client_send_text(s_ws, s, (int)len, pdMS_TO_TICKS(5000));
    if (r < 0) {
        s_ws_broken = true;
        return false;
    }
    return true;
}

static void ws_event(void *arg, esp_event_base_t base, int32_t id, void *event_data)
{
    uint32_t gen = (uint32_t)(uintptr_t)arg;
    esp_websocket_event_data_t *d = event_data;
    msg_t m = {.gen = gen};
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        m.type = M_CONNECTED;
        xQueueSend(s_rxq, &m, 0);
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_ERROR:
    case WEBSOCKET_EVENT_CLOSED:
        m.type = M_DISCONNECTED;
        xQueueSend(s_rxq, &m, 0);
        break;
    case WEBSOCKET_EVENT_DATA:
        if (d->op_code != 0x1 && !(d->op_code == 0x0 && d->payload_offset > 0)) {
            break; /* binary / control frames: ignored */
        }
        if (d->payload_offset == 0) {
            s_rx_skip = d->payload_len > RX_FRAME_MAX;
            if (!s_rx_skip && (size_t)d->payload_len + 1 > s_rx_acc_cap) {
                free(s_rx_acc);
                s_rx_acc_cap = (size_t)d->payload_len + 1;
                s_rx_acc = okou_malloc_large(s_rx_acc_cap);
                if (!s_rx_acc) {
                    s_rx_acc_cap = 0;
                    s_rx_skip = true;
                }
            }
        }
        if (s_rx_skip || d->data_len < 0 || (size_t)(d->payload_offset + d->data_len) > s_rx_acc_cap - 1) {
            break;
        }
        memcpy(s_rx_acc + d->payload_offset, d->data_ptr, d->data_len);
        if (d->payload_offset + d->data_len >= d->payload_len) {
            m.type = M_TEXT;
            m.len = (size_t)d->payload_len;
            m.data = malloc(m.len + 1);
            if (m.data) {
                memcpy(m.data, s_rx_acc, m.len);
                m.data[m.len] = '\0';
                if (xQueueSend(s_rxq, &m, 0) != pdTRUE) {
                    free(m.data);
                }
            }
            if (s_rx_acc_cap > 2048) { /* do not keep large buffers around */
                free(s_rx_acc);
                s_rx_acc = NULL;
                s_rx_acc_cap = 0;
            }
        }
        break;
    default:
        break;
    }
}

static void ws_connect(void)
{
    esp_websocket_client_config_t c = {
        .uri = s_url,
        .headers = s_headers,
        .buffer_size = 2048,
        .task_stack = 5120,
        .task_prio = CONFIG_OKOU_TASK_PRIO + 1,
        .disable_auto_reconnect = true,
        .network_timeout_ms = 10000,
        .ping_interval_sec = 300, /* protocol keep-alive is the text "ping" below */
        .disable_pingpong_discon = true,
    };
    if (!s_dev) {
        c.crt_bundle_attach = esp_crt_bundle_attach;
    }
    s_ws = esp_websocket_client_init(&c);
    if (!s_ws) {
        ESP_LOGE(TAG, "websocket init failed");
        s_next_connect_us = now_us() + 5000 * US_PER_MS;
        return;
    }
    s_gen++;
    s_ws_broken = false;
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, ws_event, (void *)(uintptr_t)s_gen);
    s_conn_start_us = now_us();
    ESP_LOGI(TAG, "connecting to %s", s_url);
    if (esp_websocket_client_start(s_ws) != ESP_OK) {
        /* Usually the websocket task stack (internal RAM) could not be allocated: say how much
         * internal RAM is left so an app that is out of it can be diagnosed from the log. */
        ESP_LOGE(TAG, "hub connection not started: internal RAM free %u, largest block %u (task needs %u)",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                 (unsigned)c.task_stack);
        esp_websocket_client_destroy(s_ws);
        s_ws = NULL;
        s_next_connect_us = now_us() + 5000 * US_PER_MS;
    }
}

static void ws_teardown(const char *why)
{
    if (s_ws) {
        esp_websocket_client_destroy(s_ws);
        s_ws = NULL;
    }
    if (s_ws_up) {
        ESP_LOGW(TAG, "hub connection closed (%s)", why);
    }
#if CONFIG_MBEDTLS_HAVE_TIME_DATE
    /* With certificate date checks on, TLS to the hub fails until the clock is set. The SDK does
     * not start SNTP itself (apps usually own it); say so instead of leaving a bare TLS error. */
    static bool s_time_hint;
    if (!s_ws_up && !s_time_hint && time(NULL) < 1704067200 /* 2024-01-01 */) {
        s_time_hint = true;
        ESP_LOGW(TAG, "system time is not set and CONFIG_MBEDTLS_HAVE_TIME_DATE is on: the hub "
                      "certificate cannot be verified until the app starts SNTP");
    }
#endif
    s_ws_up = false;
    s_hello_acked = false;
    s_gen++; /* ignore late events from the old client */
    uint32_t delay = s_backoff_ms * (80 + esp_random() % 41) / 100; /* +-20 % jitter */
    s_next_connect_us = now_us() + (int64_t)delay * US_PER_MS;
    s_backoff_ms = s_backoff_ms * 2 > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : s_backoff_ms * 2;
    ESP_LOGI(TAG, "reconnect in %" PRIu32 " ms", delay);
}

static void send_hello(void)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "t", "hello");
    hello_fill(o);
    char *s = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    if (s) {
        send_text(s, strlen(s));
        free(s);
    }
}

/* ------------------------------------------------------------------ flushing */

static void flush_logs(void)
{
    for (int i = 0; i < 4; i++) {
        size_t n = okou_log_build_frame(s_txbuf, CONFIG_OKOU_TX_FRAME_MAX);
        if (n == 0 || !send_text(s_txbuf, n)) {
            break;
        }
    }
}

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
    bool launcher = g_okou_cfg.role == OKOU_ROLE_LAUNCHER;
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
    if (s_hooks.on_request) {
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
            send_res(id, r == ESP_OK, data, err);
            return;
        }
    }
    if (strcmp(op, "status") == 0) {
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
    } else if (strcmp(op, "auth.set") == 0) {
        /* Migration from Access credentials: the hub hands the device its device token over the
         * current connection; the agent reconnects with it after this response. */
        const cJSON *t = cJSON_GetObjectItemCaseSensitive(args, "token");
        if (!cJSON_IsString(t) || strncmp(t->valuestring, "okl_dev_", 8) != 0 || strlen(t->valuestring) >= sizeof(s_tok)) {
            snprintf(err, sizeof(err), "token: okl_dev_... string required");
            r = ESP_ERR_INVALID_ARG;
        } else {
            r = okou_nvs_set_str(OKOU_KEY_TOKEN, t->valuestring);
            if (r == ESP_OK) {
                s_reload = true;
            } else {
                snprintf(err, sizeof(err), "NVS write failed");
            }
        }
    } else if (strcmp(op, "provision.reset") == 0) {
        const char *keys[] = {"ssid","pass","cid","csec","hub",OKOU_KEY_TOKEN};
        r = okou_nvs_set_str(OKOU_KEY_WIFIS, "[]");
        for (size_t i = 0; r == ESP_OK && i < sizeof(keys)/sizeof(keys[0]); ++i) {
            r = okou_nvs_erase(keys[i]);
        }
        if (r == ESP_OK && g_okou_cfg.role == OKOU_ROLE_APP) {
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
    } else if (strcmp(op, "install") == 0 && g_okou_cfg.role == OKOU_ROLE_APP) {
        snprintf(err, sizeof(err), "Enter launcher mode before OTA");
    } else {
        snprintf(err, sizeof(err), "unknown op: %s", op);
    }
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
    cJSON_AddStringToObject(o, "detected_by", g_okou_cfg.role == OKOU_ROLE_LAUNCHER ? "launcher" : "app");
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
    if (g_okou_cfg.role == OKOU_ROLE_APP && !g_okou_cfg.app_validates) {
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

/* RX cursor belongs to this boot and survives Wi-Fi reconnects. A new process ID
 * intentionally starts from zero. Never retry a partially consumed serial record. */
static void uart_input(const cJSON *root)
{
    const cJSON *seq = cJSON_GetObjectItemCaseSensitive(root, "seq");
    const cJSON *text = cJSON_GetObjectItemCaseSensitive(root, "text");
    if (!cJSON_IsNumber(seq) || seq->valuedouble != (double)uart_cursor + 1 || !cJSON_IsString(text)) return;
    cJSON *args = cJSON_CreateObject(), *reply = cJSON_CreateObject();
    if (!args || !reply || !cJSON_AddStringToObject(args, "data", text->valuestring)) {
        cJSON_Delete(args); cJSON_Delete(reply); return;
    }
    char error[128] = "terminal unavailable";
    esp_err_t result = ESP_ERR_NOT_SUPPORTED;
    for (int i = 0; i < s_nops; i++) {
        if (s_ops[i].fn && strcmp(s_ops[i].op, "term.write") == 0) {
            result = s_ops[i].fn(args, reply, error, sizeof(error));
            break;
        }
    }
    ++uart_cursor;
    if (result != ESP_OK) ESP_LOGW(TAG, "UART input %lu: %s", (unsigned long)uart_cursor, error);
    cJSON_Delete(args); cJSON_Delete(reply);
}
static void handle_text(char *s, size_t len)
{
    s_last_rx_us = now_us();
    if (len == 4 && memcmp(s, "pong", 4) == 0) {
        return;
    }
    cJSON *root = cJSON_ParseWithLength(s, len);
    if (!root) {
        ESP_LOGW(TAG, "bad frame from hub");
        return;
    }
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(root, "t");
    if (cJSON_IsString(t)) {
        if (strcmp(t->valuestring, "ack") == 0) {
            const cJSON *seq = cJSON_GetObjectItemCaseSensitive(root, "seq");
            if (cJSON_IsNumber(seq)) {
                okou_log_ack((int64_t)seq->valuedouble);
            }
            if (!s_hello_acked) {
                s_hello_acked = true;
                on_first_ack();
            }
        } else if (strcmp(t->valuestring, "uart.input") == 0) {
            uart_input(root);
        } else if (strcmp(t->valuestring, "req") == 0) {
            handle_req(root);
        }
    }
    cJSON_Delete(root);
}

static void do_reboot(void)
{
    ESP_LOGW(TAG, "rebooting");
    if (s_ws_up) {
        drain_txq();
        flush_logs();
        esp_websocket_client_close(s_ws, pdMS_TO_TICKS(500));
    }
    esp_restart();
}

static void agent_task(void *arg)
{
    for (;;) {
        msg_t m;
        if (xQueueReceive(s_rxq, &m, pdMS_TO_TICKS(50)) == pdTRUE) {
            if (m.gen != s_gen) {
                free(m.data); /* stale client */
            } else if (m.type == M_CONNECTED) {
                ESP_LOGI(TAG, "hub connected");
                s_ws_up = true;
                s_hello_acked = false;
                s_up_since_us = s_last_rx_us = s_last_ping_us = now_us();
                okou_log_rewind();
                send_hello();
            } else if (m.type == M_DISCONNECTED) {
                ws_teardown("disconnected");
            } else {
                handle_text(m.data, m.len);
                free(m.data);
            }
        }
        int64_t now = now_us();
        if (s_reload) {
            s_reload = false;
            s_cfg_ok = load_config();
            if (s_ws) {
                ws_teardown("config reload");
            }
            s_backoff_ms = 1000;
            s_next_connect_us = now;
        }
        if (s_ws_broken && s_ws) {
            ws_teardown("send failed");
        }
        if (!s_ws) {
            if (s_cfg_ok && okou_net_has_ip() && now >= s_next_connect_us) {
                ws_connect();
            }
        } else if (!s_ws_up) {
            if (now - s_conn_start_us > CONNECT_TIMEOUT_US) {
                ws_teardown("connect timeout");
            }
        } else {
            drain_txq();
            if (s_hello_acked && now - last_uart_poll >= 1500000) {
                char poll[80];
                int n = snprintf(poll, sizeof(poll), "{\"t\":\"uart.poll\",\"after\":%lu}", (unsigned long)uart_cursor);
                send_text(poll, n);
                last_uart_poll = now;
            }
            if (now - s_last_flush_us >= FLUSH_INTERVAL_US) {
                s_last_flush_us = now;
                flush_logs();
                flush_metrics();
            }
            if (now - s_last_ping_us >= PING_INTERVAL_US) {
                s_last_ping_us = now;
                send_text("ping", 4);
            }
            if (now - s_last_rx_us >= PONG_TIMEOUT_US) {
                ws_teardown("no pong for 90 s");
            } else if (!okou_net_has_ip()) {
                ws_teardown("network down");
            } else if (now - s_up_since_us >= BACKOFF_RESET_US) {
                s_backoff_ms = 1000;
            }
        }
        portENTER_CRITICAL(&s_rmux);
        int64_t rb = s_reboot_at_us;
        portEXIT_CRITICAL(&s_rmux);
        if (rb && now >= rb) {
            do_reboot();
        }
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

#if defined(CONFIG_OKOU_LAUNCHER_BUTTON_GPIO) && CONFIG_OKOU_LAUNCHER_BUTTON_GPIO >= 0
    if (g_okou_cfg.role == OKOU_ROLE_APP) {
        /* Button held while the app starts -> boot into the launcher and stay there. */
        const gpio_num_t pin = (gpio_num_t)CONFIG_OKOU_LAUNCHER_BUTTON_GPIO;
        gpio_set_direction(pin, GPIO_MODE_INPUT);
        gpio_set_pull_mode(pin, GPIO_PULLUP_ONLY);
        if (gpio_get_level(pin) == 0) {
            ESP_LOGI(TAG, "launcher button held: keep holding to boot into the launcher");
            int64_t t0 = now_us();
            while (gpio_get_level(pin) == 0) {
                if (now_us() - t0 >= (int64_t)CONFIG_OKOU_LAUNCHER_BUTTON_HOLD_MS * US_PER_MS) {
                    const esp_partition_t *lp = okou_launcher_partition();
                    if (lp) {
                        okou_nvs_set_u8(OKOU_KEY_HOLD, 1);
                        if (esp_ota_set_boot_partition(lp) == ESP_OK) {
                            ESP_LOGW(TAG, "launcher button: rebooting into %s (stays there)", lp->label);
                            vTaskDelay(pdMS_TO_TICKS(100));
                            esp_restart();
                        }
                    }
                    break;
                }
                vTaskDelay(pdMS_TO_TICKS(20));
            }
        }
    }
#endif

    if (g_okou_cfg.role == OKOU_ROLE_APP && !g_okou_cfg.app_validates && CONFIG_OKOU_MAX_FAIL_BOOTS > 0) {
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
    const esp_app_desc_t *d = esp_app_get_description();
    ESP_LOGI(TAG, "agent start: %s %s role=%s boot_id=%s", d->project_name, d->version,
             g_okou_cfg.role == OKOU_ROLE_LAUNCHER ? "launcher" : "app", s_boot_id);
    if (xTaskCreate(agent_task, "okou_agent", CONFIG_OKOU_TASK_STACK, NULL, CONFIG_OKOU_TASK_PRIO, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
#if CONFIG_OKL_URL_OTA || CONFIG_OKOU_MICROPYTHON_RUNTIME
    xTaskCreate(sntp_task, "okl_sntp", 3072, NULL, 3, NULL);
#endif
    return ESP_OK;
}
