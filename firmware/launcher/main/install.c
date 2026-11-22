/*
 * Streaming firmware install (docs/protocol.md "install" + "Install rules").
 *
 * The image is streamed from the hub straight into the target partition while hashing.
 * The first 4 KiB (image header) are held back in RAM and written only after size,
 * SHA-256 and chip id check out, so a rejected or partial download can never be booted (the
 * header sector stays erased). Transport security is HTTPS to the hub; there is no
 * application-layer signature (a `sig` argument from older hubs is ignored).
 *
 * SPDX-License-Identifier: MIT
 */
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_app_format.h"
#include "mbedtls/sha256.h"
#include "mbedtls/pk.h"
#include "mbedtls/base64.h"
#include "okou_agent.h"
#include "okou_agent_ext.h"
#include "launcher.h"
#include "sdkconfig.h"

static const char *TAG = "install";


#define HOLD_SZ 4096
#define CHUNK 4096
#define MAX_ATTEMPTS 3

typedef struct {
    char kind[10];
    char sha[65];
    char url[256];
    char version[32];
    uint32_t size;
} inst_t;

static volatile bool s_running;

bool install_running(void)
{
    return s_running;
}

const esp_partition_t *launcher_inactive_slot(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    const char *other = NULL;
    if (strcmp(run->label, "launcher_a") == 0) {
        other = "launcher_b";
    } else if (strcmp(run->label, "launcher_b") == 0) {
        other = "launcher_a";
    }
    return other ? esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, other) : NULL;
}

static const esp_partition_t *target_for(const char *kind)
{
    if (strcmp(kind, "app") == 0) {
        return esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, "app");
    }
    return launcher_inactive_slot();
}

static void str_arg(const cJSON *a, const char *k, char *dst, size_t n)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(a, k);
    dst[0] = '\0';
    if (cJSON_IsString(v)) {
        strlcpy(dst, v->valuestring, n);
    }
}

static bool parse_args(const cJSON *a, inst_t *o, char *err, size_t n)
{
    memset(o, 0, sizeof(*o));
    str_arg(a, "kind", o->kind, sizeof(o->kind));
    str_arg(a, "sha256", o->sha, sizeof(o->sha));
    str_arg(a, "url", o->url, sizeof(o->url));
    str_arg(a, "version", o->version, sizeof(o->version));
    const cJSON *size = cJSON_GetObjectItemCaseSensitive(a, "size");
    if (strcmp(o->kind, "app") && strcmp(o->kind, "launcher")) {
        snprintf(err, n, "kind must be app or launcher");
        return false;
    }
    if (strcmp(o->kind, "launcher") == 0) {
        const cJSON *board = cJSON_GetObjectItemCaseSensitive(a, "board");
#if CONFIG_OKL_BOARD_M5_STOPWATCH
        const char *expected = "stopwatch";
#else
        const char *expected = "paper-color";
#endif
        if (!cJSON_IsString(board) || strcmp(board->valuestring, expected) != 0) {
            snprintf(err, n, "launcher package must match board %s", expected);
            return false;
        }
    }
    if (strlen(o->sha) != 64) {
        snprintf(err, n, "sha256 must be 64 hex chars");
        return false;
    }
    for (int i = 0; i < 64; i++) {
        if (!isxdigit((unsigned char)o->sha[i])) {
            snprintf(err, n, "sha256 must be 64 hex chars");
            return false;
        }
        o->sha[i] = (char)tolower((unsigned char)o->sha[i]);
    }
    if (cJSON_IsNumber(size)) {
        if (size->valuedouble <= 0 || size->valuedouble > 16 * 1024 * 1024) {
            snprintf(err, n, "bad size");
            return false;
        }
        o->size = (uint32_t)size->valuedouble;
    }
    const esp_partition_t *t = target_for(o->kind);
    if (!t) {
        snprintf(err, n, strcmp(o->kind, "launcher") == 0
                             ? "launcher self-update not supported on this partition layout (USB only)"
                             : "no app partition");
        return false;
    }
    if (o->size && o->size > t->size) {
        snprintf(err, n, "image (%" PRIu32 " B) larger than partition %s (%" PRIu32 " B)", o->size, t->label,
                 t->size);
        return false;
    }
    return true;
}

static void emit_failed(const inst_t *in, const char *msg)
{
    ESP_LOGE(TAG, "install %.12s failed: %s", in->sha, msg);
    cJSON *d = cJSON_CreateObject();
    cJSON_AddStringToObject(d, "sha256", in->sha);
    cJSON_AddStringToObject(d, "error", msg);
    okou_event_json("install.failed", d);
    okou_nvs_erase(OKOU_KEY_PENDING);
    okou_set_install_state("failed");
}

static void emit_progress(const inst_t *in, uint32_t written, uint32_t size)
{
    cJSON *d = cJSON_CreateObject();
    cJSON_AddStringToObject(d, "sha256", in->sha);
    cJSON_AddNumberToObject(d, "written", written);
    cJSON_AddNumberToObject(d, "size", size);
    okou_event_json("install.progress", d);
}

static void run_install(inst_t *in)
{
    char err[160];
    const esp_partition_t *target = target_for(in->kind);
    if (!target) {
        emit_failed(in, "no target partition");
        return;
    }
    /* Credentials are only ever sent to our own hub: /device/images/<sha> URLs are
     * fetched from the configured hub base regardless of the host in `url`. */
    char base[128] = "";
    char url[320];
    bool to_hub = true;
    okou_hub_http_base(base, sizeof(base));
    const char *path = in->url[0] ? strstr(in->url, "/device/images/") : NULL;
    if (!in->url[0]) {
        snprintf(url, sizeof(url), "%s/device/images/%s", base, in->sha);
    } else if (path) {
        snprintf(url, sizeof(url), "%s%s", base, path);
    } else {
        strlcpy(url, in->url, sizeof(url));
        to_hub = false;
    }
    ESP_LOGI(TAG, "install %s %.12s... -> %s from %s", in->kind, in->sha, target->label, url);
    okou_set_install_state("downloading");

    esp_http_client_config_t hc = {
        .url = url,
        .timeout_ms = 20000,
        .buffer_size = 2048,
        .buffer_size_tx = 1024,
    };
    if (strncmp(url, "https://", 8) == 0) {
        hc.crt_bundle_attach = esp_crt_bundle_attach;
    }
    esp_http_client_handle_t c = esp_http_client_init(&hc);
    if (!c) {
        emit_failed(in, "http client init failed");
        return;
    }
    if (to_hub) {
        okou_http_apply_auth(c);
    }
    uint8_t *buf = malloc(CHUNK);
    uint8_t *hold = malloc(HOLD_SZ);
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    esp_ota_handle_t h = 0;
    bool ota_open = false;
    const char *fail = NULL;
    uint32_t written = 0, hold_len = 0, size = 0;

    esp_err_t e = (buf && hold) ? esp_http_client_open(c, 0) : ESP_ERR_NO_MEM;
    if (e != ESP_OK) {
        snprintf(err, sizeof(err), "download failed: %s", esp_err_to_name(e));
        fail = err;
        goto out;
    }
    int64_t cl = esp_http_client_fetch_headers(c);
    int status = esp_http_client_get_status_code(c);
    if (status != 200) {
        snprintf(err, sizeof(err), "download failed: HTTP %d", status);
        fail = err;
        goto out;
    }
    size = in->size ? in->size : (cl > 0 ? (uint32_t)cl : 0);
    if (in->size && cl > 0 && (uint32_t)cl != in->size) {
        snprintf(err, sizeof(err), "size mismatch: Content-Length %lld, expected %" PRIu32, (long long)cl, in->size);
        fail = err;
        goto out;
    }
    if (size == 0 || size > target->size) {
        snprintf(err, sizeof(err), "bad image size %" PRIu32 " for %s (%" PRIu32 ")", size, target->label,
                 target->size);
        fail = err;
        goto out;
    }
    e = esp_ota_begin(target, size, &h); /* erases [0, size) up front */
    if (e != ESP_OK) {
        snprintf(err, sizeof(err), "esp_ota_begin: %s", esp_err_to_name(e));
        fail = err;
        goto out;
    }
    ota_open = true;
    mbedtls_sha256_starts(&sha, 0);
    bool chip_ok = false;
    uint32_t next_pct = 10;
    while (written < size) {
        uint32_t want = size - written < CHUNK ? size - written : CHUNK;
        int r = esp_http_client_read(c, (char *)buf, (int)want);
        if (r < 0) {
            snprintf(err, sizeof(err), "read error after %" PRIu32 " bytes", written);
            fail = err;
            goto out;
        }
        if (r == 0) {
            snprintf(err, sizeof(err), "size mismatch: stream ended at %" PRIu32 " of %" PRIu32, written, size);
            fail = err;
            goto out;
        }
        mbedtls_sha256_update(&sha, buf, (size_t)r);
        uint32_t off = 0;
        if (written < HOLD_SZ) {
            off = (uint32_t)r < HOLD_SZ - written ? (uint32_t)r : HOLD_SZ - written;
            memcpy(hold + written, buf, off);
            hold_len = written + off;
            if (!chip_ok && hold_len >= sizeof(esp_image_header_t)) {
                const esp_image_header_t *ih = (const esp_image_header_t *)hold;
                if (ih->magic != ESP_IMAGE_HEADER_MAGIC) {
                    fail = "not an ESP app image (bad magic)";
                    goto out;
                }
                if (ih->chip_id != CONFIG_IDF_FIRMWARE_CHIP_ID) {
                    snprintf(err, sizeof(err), "chip id mismatch: image %u, device %u", (unsigned)ih->chip_id,
                             (unsigned)CONFIG_IDF_FIRMWARE_CHIP_ID);
                    fail = err;
                    goto out;
                }
                chip_ok = true;
            }
        }
        if ((uint32_t)r > off) {
            e = esp_ota_write_with_offset(h, buf + off, (uint32_t)r - off, written + off);
            if (e != ESP_OK) {
                snprintf(err, sizeof(err), "flash write: %s", esp_err_to_name(e));
                fail = err;
                goto out;
            }
        }
        written += (uint32_t)r;
        uint32_t pct = (uint32_t)((uint64_t)written * 100 / size);
        if (pct >= next_pct) {
            emit_progress(in, written, size);
            next_pct = (pct / 10 + 1) * 10;
        }
    }
    if (!chip_ok) {
        fail = "image too small";
        goto out;
    }
    uint8_t digest[32];
    char hex[65];
    mbedtls_sha256_finish(&sha, digest);
    for (int i = 0; i < 32; i++) {
        snprintf(hex + 2 * i, 3, "%02x", digest[i]);
    }
    if (strcmp(hex, in->sha) != 0) {
        snprintf(err, sizeof(err), "sha256 mismatch: got %.16s...", hex);
        fail = err;
        goto out;
    }
    okou_set_install_state("verifying");
    e = esp_ota_write_with_offset(h, hold, hold_len, 0);
    if (e != ESP_OK) {
        snprintf(err, sizeof(err), "flash write (header): %s", esp_err_to_name(e));
        fail = err;
        goto out;
    }
    ota_open = false;
    e = esp_ota_end(h);
    if (e != ESP_OK) {
        snprintf(err, sizeof(err), "image validation failed: %s", esp_err_to_name(e));
        fail = err;
        goto out;
    }
    e = esp_ota_set_boot_partition(target);
    if (e != ESP_OK) {
        snprintf(err, sizeof(err), "set boot partition: %s", esp_err_to_name(e));
        fail = err;
        goto out;
    }

out:
    if (ota_open) {
        esp_ota_abort(h);
    }
    mbedtls_sha256_free(&sha);
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    free(buf);
    free(hold);
    if (fail) {
        /* The header sector was never written, so nothing bootable is left behind. */
        emit_failed(in, fail);
        return;
    }
    ESP_LOGI(TAG, "install %.12s done (%" PRIu32 " bytes) -> rebooting into %s", in->sha, written, target->label);
    cJSON *d = cJSON_CreateObject();
    cJSON_AddStringToObject(d, "sha256", in->sha);
    cJSON_AddStringToObject(d, "version", in->version);
    cJSON_AddStringToObject(d, "kind", in->kind);
    okou_event_json("install.done", d);
    okou_nvs_erase(OKOU_KEY_PENDING);
    okou_set_install_state("done");
    if (strcmp(in->kind, "app") == 0) {
        okou_nvs_set_u8(OKOU_KEY_FAIL_BOOTS, 0);
    }
    okou_schedule_reboot(1500);
}

static void install_task(void *arg)
{
    inst_t *in = arg;
    run_install(in);
    free(in);
    s_running = false;
    vTaskDelete(NULL);
}

static bool start_task(inst_t *in)
{
    s_running = true;
    if (xTaskCreate(install_task, "okl_install", 8192, in, 2, NULL) != pdPASS) {
        s_running = false;
        return false;
    }
    return true;
}

esp_err_t install_op(const cJSON *args, cJSON *data, char *err, size_t errlen)
{
    if (s_running) {
        snprintf(err, errlen, "install already in progress");
        return ESP_ERR_INVALID_STATE;
    }
    inst_t *in = malloc(sizeof(*in));
    if (!in) {
        snprintf(err, errlen, "out of memory");
        return ESP_ERR_NO_MEM;
    }
    if (!parse_args(args, in, err, errlen)) {
        free(in);
        return ESP_ERR_INVALID_ARG;
    }
    /* Persist so a power loss mid-download resumes after reconnecting. */
    cJSON *p = cJSON_Duplicate(args, true);
    cJSON_DeleteItemFromObject(p, "attempts");
    cJSON_AddNumberToObject(p, "attempts", 1);
    char *s = cJSON_PrintUnformatted(p);
    cJSON_Delete(p);
    if (s) {
        okou_nvs_set_str(OKOU_KEY_PENDING, s);
        free(s);
    }
    okou_set_install_state("queued");
    if (!start_task(in)) {
        free(in);
        okou_nvs_erase(OKOU_KEY_PENDING);
        snprintf(err, errlen, "cannot start install task");
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddBoolToObject(data, "accepted", true);
    return ESP_OK;
}

void install_resume_pending(void)
{
    if (s_running) {
        return;
    }
    char *p = okou_nvs_get_str_alloc(OKOU_KEY_PENDING);
    if (!p) {
        return;
    }
    cJSON *j = cJSON_Parse(p);
    free(p);
    inst_t *in = malloc(sizeof(*in));
    char err[160] = "";
    if (!j || !in) {
        okou_nvs_erase(OKOU_KEY_PENDING);
        cJSON_Delete(j);
        free(in);
        return;
    }
    const cJSON *att = cJSON_GetObjectItemCaseSensitive(j, "attempts");
    int attempts = cJSON_IsNumber(att) ? att->valueint : 0;
    if (!parse_args(j, in, err, sizeof(err))) {
        emit_failed(in, err);
    } else if (attempts >= MAX_ATTEMPTS) {
        emit_failed(in, "giving up after 3 attempts");
    } else {
        cJSON_DeleteItemFromObject(j, "attempts");
        cJSON_AddNumberToObject(j, "attempts", attempts + 1);
        char *s = cJSON_PrintUnformatted(j);
        if (s) {
            okou_nvs_set_str(OKOU_KEY_PENDING, s);
            free(s);
        }
        ESP_LOGI(TAG, "resuming pending install %.12s (attempt %d)", in->sha, attempts + 1);
        cJSON_Delete(j);
        if (start_task(in)) {
            return;
        }
        emit_failed(in, "cannot start install task");
        free(in);
        return;
    }
    cJSON_Delete(j);
    free(in);
}
