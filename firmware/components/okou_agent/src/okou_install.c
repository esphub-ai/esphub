/* Streaming HTTPS OTA. SPDX-License-Identifier: MIT */
#include <stdio.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <strings.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_app_format.h"
#include "esp_app_desc.h"
#include "okou_install.h"
#include "okou_agent.h"
#include "okou_agent_ext.h"
#include "sdkconfig.h"
#include "esp_littlefs.h"
#include "mbedtls/sha256.h"

#define CHUNK 4096
#define PROGRAM_LIMIT (32 * 1024)
#define PROGRAM "/flash/main.py"
#define MAX_ATTEMPTS 3
#define PROFILE_OFFSET (sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t) + sizeof(esp_app_desc_t))
static bool device_board(char board[OKOU_BOARD_CAPACITY])
{
    return okou_nvs_get_str(OKOU_BOARD_KEY, board, OKOU_BOARD_CAPACITY) == ESP_OK && board[0];
}

static const char *TAG = "install";
typedef struct {
    char kind[16];
    char url[1025];
    char id[37];
} inst_t;
static volatile bool s_running;

static const esp_partition_t *runtime_partition(void)
{
    return esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, "app");
}

static bool https_url(const char *url)
{
    if (!url || strncmp(url, "https://", 8) || strpbrk(url, "\r\n\t \\#")) return false;
    const char *host = url + 8;
    size_t len = strcspn(host, "/?");
    return len > 0 && !memchr(host, '@', len);
}

static bool parse_args(const cJSON *a, inst_t *in, char *err, size_t n)
{
    memset(in, 0, sizeof(*in));
    const char *kind = cJSON_GetStringValue(cJSON_GetObjectItem(a, "kind"));
    const char *board = cJSON_GetStringValue(cJSON_GetObjectItem(a, "board"));
    const char *url = cJSON_GetStringValue(cJSON_GetObjectItem(a, "url"));
    const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(a, "transfer_id"));
    if (!kind || (strcmp(kind, "bootloader") && strcmp(kind, "micropython") && strcmp(kind, "python"))) {
        snprintf(err, n, "Expected bootloader, micropython or python"); return false;
    }
    char expected[OKOU_BOARD_CAPACITY];
    if (!device_board(expected)) { snprintf(err, n, "Device board is missing from NVS"); return false; }
    if (!board || strcmp(board, expected)) { snprintf(err, n, "Expected board %s", expected); return false; }
    if (!https_url(url) || strlen(url) >= sizeof(in->url)) {
        snprintf(err, n, "Expected HTTPS URL (up to 1024 bytes)"); return false;
    }
    strlcpy(in->kind, kind, sizeof(in->kind));
    strlcpy(in->url, url, sizeof(in->url));
    if (!id || strlen(id) != 36) { snprintf(err, n, "Invalid transfer ID"); return false; }
    strlcpy(in->id, id, sizeof(in->id));
    return true;
}

static cJSON *receipt(const inst_t *in)
{
    cJSON *d = cJSON_CreateObject();
    cJSON_AddStringToObject(d, "kind", in->kind);
    if (*in->id) cJSON_AddStringToObject(d, "transfer_id", in->id);
    return d;
}

// Replace the download job atomically. Either the job or its final receipt
// survives power loss. The agent erases the receipt only after the relay ACK.
static bool save_result(const char *name, cJSON *data, const char *target)
{
    cJSON *frame = cJSON_CreateObject();
    char *encoded = NULL;
    if (data && cJSON_AddItemToObject(frame, "data", data)) {
        data = NULL;
        if (cJSON_AddStringToObject(frame, "t", "event") &&
            cJSON_AddStringToObject(frame, "name", name) &&
            (!target || cJSON_AddStringToObject(frame, "target", target)))
            encoded = cJSON_PrintUnformatted(frame);
    }
    bool saved = encoded && okou_nvs_set_str(OKOU_KEY_PENDING, encoded) == ESP_OK;
    if (saved) okou_install_result_ready();
    else ESP_LOGE(TAG, "Cannot persist terminal install result");
    free(encoded);
    cJSON_Delete(data);
    cJSON_Delete(frame);
    return saved;
}

static void emit_failed(const inst_t *in, const char *msg)
{
    ESP_LOGE(TAG, "%s OTA: %s", in->kind, msg);
    cJSON *d = receipt(in);
    cJSON_AddStringToObject(d, "error", msg);
    save_result("install.failed", d, NULL);
    okou_set_install_state("failed");
}

static esp_err_t on_header(esp_http_client_event_t *e)
{
    if (e->event_id == HTTP_EVENT_ON_HEADER && !strcasecmp(e->header_key, "Location")) {
        *(bool *)e->user_data = https_url(e->header_value) ||
            (e->header_value[0] == '/' && e->header_value[1] != '/' && !strchr(e->header_value, '\\'));
    }
    return ESP_OK;
}

static bool is_private_program(const char *url)
{
    char base[192];
    if (okou_hub_http_base(base, sizeof(base)) != ESP_OK) return false;
    size_t n = strlen(base);
    const char prefix[] = "/api/device/programs/";
    return !strncmp(url, base, n) && !strncmp(url + n, prefix, sizeof(prefix) - 1);
}

static const char *open_download(esp_http_client_handle_t c, bool private_program, bool *safe_redirect,
                                 int64_t *length)
{
    if (private_program) okou_http_apply_auth(c);
    for (int hop = 0; hop <= 5; hop++) {
        *safe_redirect = false;
        if (esp_http_client_open(c, 0) != ESP_OK) return "HTTPS connection failed";
        *length = esp_http_client_fetch_headers(c);
        int status = esp_http_client_get_status_code(c);
        if (*length < 0) return "Invalid HTTPS response headers";
        if (status == 200) return NULL;
        if (private_program || !*safe_redirect || hop == 5 ||
            (status != 301 && status != 302 && status != 303 && status != 307 && status != 308)) {
            return "Download refused or invalid redirect";
        }
        esp_http_client_close(c);
        if (esp_http_client_set_redirection(c) != ESP_OK) return "Invalid redirect URL";
    }
    return "Too many redirects";
}

static bool matches_profile(const uint8_t *profile, const char *expected)
{
    size_t len = strlen(expected) + 1;
    return !memcmp(profile, expected, len) &&
           !memcmp(profile + len, OKOU_OTA_CAPABILITY, sizeof(OKOU_OTA_CAPABILITY));
}

static bool valid_header(const uint8_t *header, const char *kind, const char *board)
{
    const esp_image_header_t *ih = (const esp_image_header_t *)header;
    if (ih->magic != ESP_IMAGE_HEADER_MAGIC || ih->chip_id != CONFIG_IDF_FIRMWARE_CHIP_ID) return false;
    const uint8_t *profile = header + PROFILE_OFFSET;
    bool bootloader = !strcmp(kind, "bootloader");
    if (bootloader)
        return CONFIG_OKOU_BL_PROFILE[0] &&
               matches_profile(profile, OKOU_BL_IMAGE_PREFIX CONFIG_OKOU_BL_PROFILE);
    char expected[sizeof("ESPHUB2/micropython/") + OKOU_BOARD_CAPACITY];
    snprintf(expected, sizeof(expected), "ESPHUB2/micropython/%s", board);
    return matches_profile(profile, expected);
}

static bool compatible_runtime(const esp_partition_t *app, const char *board)
{
    char expected[sizeof("ESPHUB2/micropython/") + OKOU_BOARD_CAPACITY];
    uint8_t profile[sizeof(expected) + sizeof(OKOU_OTA_CAPABILITY)];
    snprintf(expected, sizeof(expected), "ESPHUB2/micropython/%s", board);
    esp_app_desc_t desc;
    return app && esp_ota_get_partition_description(app, &desc) == ESP_OK &&
           esp_partition_read(app, PROFILE_OFFSET, profile, sizeof(profile)) == ESP_OK &&
           matches_profile(profile, expected);
}

/* Write the firmware header last so a partial image cannot boot. */
static bool run_install(inst_t *in)
{
    char board[OKOU_BOARD_CAPACITY];
    if (!device_board(board)) {
        emit_failed(in, "Device board is missing");
        return false;
    }
    bool bootloader = !strcmp(in->kind, "bootloader");
    bool script = !strcmp(in->kind, "python");
    const esp_partition_t *run = esp_ota_get_running_partition();
    const esp_partition_t *target = runtime_partition();
    if (bootloader) {
        if (!strcmp(run->label, "launcher_a"))
            target = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, "launcher_b");
        else if (!strcmp(run->label, "launcher_b"))
            target = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, "launcher_a");
        else
            target = NULL;
    }
    bool private_program = is_private_program(in->url), safe_redirect = false;
    esp_http_client_config_t config = {
        .url = in->url, .crt_bundle_attach = esp_crt_bundle_attach, .timeout_ms = 20000,
        .transport_type = HTTP_TRANSPORT_OVER_SSL, .buffer_size = 2048, .buffer_size_tx = 4096,
        .disable_auto_redirect = true, .event_handler = on_header, .user_data = &safe_redirect,
    };
    esp_http_client_handle_t c = esp_http_client_init(&config);
    esp_ota_handle_t ota = 0;
    bool ota_open = false;
    bool mounted = false;
    bool partial_program = false;
    uint8_t *buf = malloc(CHUNK), *header = script ? NULL : malloc(CHUNK);
    int fd = -1;
    int64_t length = 0;
    uint32_t written = 0;
    const char *fail = NULL;
    mbedtls_sha256_context sha;
    uint8_t hash[32];
    char digest[65];
    mbedtls_sha256_init(&sha);
    if (script && mbedtls_sha256_starts(&sha, 0)) { fail = "Cannot hash main.py"; goto out; }
    if (!c || !buf || (!script && !header)) { fail = "Out of memory"; goto out; }
    if (!target || target->address == esp_ota_get_running_partition()->address) { fail = "Incompatible partition layout"; goto out; }
    if (script && !compatible_runtime(target, board)) {
        fail = "Install the matching URL OTA MicroPython runtime first"; goto out;
    }
    uint32_t limit = script ? PROGRAM_LIMIT : target->size;
    okou_set_install_state("downloading");
    fail = open_download(c, private_program, &safe_redirect, &length);
    if (fail) goto out;
    if (length > limit) { fail = "Download exceeds target size"; goto out; }
    if (script) {
        const esp_vfs_littlefs_conf_t fs = {.base_path = "/flash", .partition_label = "data"};
        if (esp_vfs_littlefs_register(&fs) != ESP_OK) {
            fail = "Cannot mount data partition. Boot the matching runtime once on the setup layout"; goto out;
        }
        mounted = true;
        fd = open(PROGRAM, O_WRONLY | O_CREAT | O_TRUNC, 0666);
        if (fd < 0) { fail = "Cannot open main.py"; goto out; }
        partial_program = true;
    }
    for (;;) {
        int n = esp_http_client_read(c, (char *)buf, CHUNK);
        if (n < 0) { fail = "HTTPS read failed"; goto out; }
        if (!n) break;
        if ((uint32_t)n > limit - written) { fail = "Download exceeds target size"; goto out; }
        if (script) {
            if (mbedtls_sha256_update(&sha, buf, n) || memchr(buf, 0, n) || write(fd, buf, n) != n) {
                fail = "Invalid Python source or main.py write failed"; goto out;
            }
        } else {
            uint32_t off = 0;
            if (written < CHUNK) {
                off = (uint32_t)n < CHUNK - written ? (uint32_t)n : CHUNK - written;
                memcpy(header + written, buf, off);
                if (written + off == CHUNK) {
                    if (!valid_header(header, in->kind, board)) { fail = "Firmware type, board, chip or flash profile mismatch"; goto out; }
                    if (esp_ota_begin(target, length > 0 ? (size_t)length : OTA_SIZE_UNKNOWN, &ota) != ESP_OK) {
                        fail = "Cannot open target partition"; goto out;
                    }
                    ota_open = true;
                }
            }
            if ((uint32_t)n > off && esp_ota_write_with_offset(ota, buf + off, n - off, written + off) != ESP_OK) {
                fail = "Flash write failed"; goto out;
            }
        }
        written += n;
    }
    if (!written || (length > 0 && written != length) || !esp_http_client_is_complete_data_received(c)) {
        fail = "Incomplete download"; goto out;
    }
    okou_set_install_state("verifying");
    if (script) {
        int closed = close(fd);
        fd = -1;
        if (closed) { fail = "Cannot finish main.py"; goto out; }
        if (mbedtls_sha256_finish(&sha, hash)) { fail = "Cannot hash main.py"; goto out; }
        for (size_t i = 0; i < sizeof(hash); ++i) snprintf(digest + 2*i, 3, "%02x", hash[i]);
        partial_program = false;
    } else {
        if (!ota_open || esp_ota_write_with_offset(ota, header, CHUNK, 0) != ESP_OK) { fail = "Invalid image header"; goto out; }
        ota_open = false;
        if (esp_ota_end(ota) != ESP_OK) { fail = "ESP image validation failed"; goto out; }
    }
    cJSON *result = receipt(in);
    if (!result || !cJSON_AddNumberToObject(result, "bytes", written) ||
        (script && !cJSON_AddStringToObject(result, "sha256", digest))) {
        cJSON_Delete(result);
        fail = "Cannot build install receipt"; goto out;
    }
    if (!save_result("install.done", result, target->label)) {
        fail = "Cannot persist install receipt"; goto out;
    }
    if (esp_ota_set_boot_partition(target) != ESP_OK) {
        fail = "Cannot select boot partition"; goto out;
    }

out:
    mbedtls_sha256_free(&sha);
    if (ota_open) esp_ota_abort(ota);
    if (fd >= 0) close(fd);
    if (partial_program) unlink(PROGRAM);
    if (mounted) esp_vfs_littlefs_unregister("data");
    if (c) esp_http_client_cleanup(c);
    free(buf);
    free(header);
    if (fail) { emit_failed(in, fail); return false; }
    okou_set_install_state("done");
    if (strcmp(in->kind, "bootloader")) okou_nvs_set_u8(OKOU_KEY_FAIL_BOOTS, 0);
    okou_schedule_reboot(1500);
    return true;
}
static void install_task(void *arg)
{
    inst_t *in = arg;
    okou_pause_mqtt();
    bool rebooting = run_install(in);
    okou_resume_mqtt();
    free(in);
    if (!rebooting) s_running = false;
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
    char *s = NULL;
    if (p && cJSON_AddNumberToObject(p, "attempts", 1) &&
        (strcmp(in->kind, "bootloader") || cJSON_AddStringToObject(p, "source_slot", esp_ota_get_running_partition()->label)))
        s = cJSON_PrintUnformatted(p);
    cJSON_Delete(p);
    esp_err_t saved = s ? okou_nvs_set_str(OKOU_KEY_PENDING, s) : ESP_ERR_NO_MEM;
    free(s);
    if (saved != ESP_OK) {
        free(in);
        snprintf(err, errlen, "Cannot persist pending update");
        return saved;
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
        ESP_LOGE(TAG, "Cannot load pending install");
        cJSON_Delete(j);
        free(in);
        return;
    }
    if (cJSON_GetObjectItem(j, "t")) {
        free(in);
        cJSON_Delete(j);
        return; // Terminal record is owned by the MQTT agent.
    }
    const cJSON *att = cJSON_GetObjectItemCaseSensitive(j, "attempts");
    const char *source = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(j, "source_slot"));
    const char *running = esp_ota_get_running_partition()->label;
    int attempts = cJSON_IsNumber(att) ? att->valueint : 0;
    if (!parse_args(j, in, err, sizeof(err))) {
        emit_failed(in, err);
    } else if (!strcmp(in->kind, "bootloader") && (!source || strcmp(source, running))) {
        // A completed write has already replaced this job with a verified receipt.
        emit_failed(in, "Bootloader slot changed before the write completed");
    } else if (attempts >= MAX_ATTEMPTS) {
        emit_failed(in, "giving up after 3 attempts");
    } else {
        cJSON_DeleteItemFromObject(j, "attempts");
        cJSON_AddNumberToObject(j, "attempts", attempts + 1);
        char *s = cJSON_PrintUnformatted(j);
        if (!s || okou_nvs_set_str(OKOU_KEY_PENDING, s) != ESP_OK) {
            free(s);
            emit_failed(in, "Cannot record install retry");
            cJSON_Delete(j);
            free(in);
            return;
        }
        free(s);
        ESP_LOGI(TAG, "resuming pending install %.12s (attempt %d)", in->kind, attempts + 1);
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
