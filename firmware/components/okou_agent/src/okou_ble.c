// Paper Color: recognize a host's rotating service UUID, then serve TLS over GATT.
// Only the BLE worker reads/writes TLS state. NimBLE callbacks move bounded chunks.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "okou_ble.h"
#include "okou_agent_ext.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "mbedtls/ssl.h"
#include "mbedtls/md.h"
#include "mbedtls/platform_util.h"
#include "psa/crypto.h"

#define BOOT_SCAN_MS 12000
#define IO_CHUNK 20
#define NO_CONN BLE_HS_CONN_HANDLE_NONE
static const ble_uuid128_t service = BLE_UUID128_INIT(0x01, 0x21, 0x91, 0xfa, 0x24, 0x77, 0x10, 0xae, 0x1f,
                                                      0x48, 0x36, 0x6c, 0x31, 0xfb, 0xee, 0xa2);
static const ble_uuid128_t channel = BLE_UUID128_INIT(0x02, 0x21, 0x91, 0xfa, 0x24, 0x77, 0x10, 0xae, 0x1f,
                                                      0x48, 0x36, 0x6c, 0x31, 0xfb, 0xee, 0xa2);
static StreamBufferHandle_t rx, tx;
static TaskHandle_t worker;
static SemaphoreHandle_t key_lock;
static uint8_t address_type, root_key[32], session_key[32];
static ble_uuid128_t reply_uuid;
static volatile uint16_t connection = NO_CONN;
static volatile bool matched, synced;
static unsigned scan_generation;
static int64_t io_deadline;

static int nibble(char ch)
{
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    return -1;
}

static bool decode(const char *hex, uint8_t key[32])
{
    if (!hex || strlen(hex) != 64) return false;
    for (int i = 0; i < 32; i++) {
        int a = nibble(hex[2 * i]), b = nibble(hex[2 * i + 1]);
        if (a < 0 || b < 0) return false;
        key[i] = (uint8_t)((a << 4) | b);
    }
    return true;
}

// A single NVS value commits key and generation together.
static unsigned read_key(uint8_t *out)
{
    char record[84];
    if (okou_nvs_get_str("ble_key", record, sizeof(record)) != ESP_OK) return 0;
    char *end;
    unsigned long gen = strtoul(record, &end, 10);
    bool valid = *end == ':' && gen > 0 && gen <= INT32_MAX && (!out || decode(end + 1, out));
    mbedtls_platform_zeroize(record, sizeof(record));
    return valid ? (unsigned)gen : 0;
}

unsigned okou_ble_generation(void) { return read_key(NULL); }
bool okou_ble_busy(void) { return matched || connection != NO_CONN; }

esp_err_t okou_ble_install(unsigned gen, const char *hex, bool usb)
{
    uint8_t key[32], old[32];
    if (!key_lock || !decode(hex, key)) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(key_lock, portMAX_DELAY);
    unsigned current = read_key(old);
    esp_err_t rc = ESP_ERR_INVALID_STATE;
    if (current == gen && !memcmp(old, key, sizeof(key)))
        rc = ESP_OK;
    else if ((usb && !current && gen == 1) || (!usb && current && gen == current + 1)) {
        char record[84];
        snprintf(record, sizeof(record), "%u:%s", gen, hex);
        rc = okou_nvs_set_str("ble_key", record);
        mbedtls_platform_zeroize(record, sizeof(record));
        if (rc == ESP_OK && connection != NO_CONN) ble_gap_terminate(connection, BLE_ERR_REM_USER_CONN_TERM);
    }
    xSemaphoreGive(key_lock);
    mbedtls_platform_zeroize(key, sizeof(key));
    mbedtls_platform_zeroize(old, sizeof(old));
    return rc;
}

static bool derive(const char *label, const uint8_t nonce[8], uint8_t out[32])
{
    uint8_t buf[64];
    int n = snprintf((char *)buf, sizeof(buf), "esphub/wifi/uuid-v1/%s", label) + 1;
    memcpy(buf + n, nonce, 8);
    return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), root_key, sizeof(root_key), buf,
                           n + 8, out) == 0;
}

static int gap_event(struct ble_gap_event *e, void *unused)
{
    if (e->type == BLE_GAP_EVENT_DISC && !matched) {
        struct ble_hs_adv_fields f;
        if (ble_hs_adv_parse_fields(&f, e->disc.data, e->disc.length_data) != 0) return 0;
        for (int i = 0; i < f.num_uuids128; i++) {
            uint8_t wire[16], tag[32];
            for (int j = 0; j < 16; j++)
                wire[j] = f.uuids128[i].value[15 - j];
            if (!derive("beacon", wire, tag) || memcmp(tag, wire + 8, 8)) continue;
            if (!derive("session", wire, session_key)) continue;
            reply_uuid = f.uuids128[i];
            reply_uuid.value[15] ^= 0x80;
            matched = true;
            ble_gap_disc_cancel();
            xTaskNotifyGive(worker);
            break;
        }
    } else if (e->type == BLE_GAP_EVENT_CONNECT) {
        connection = e->connect.status ? NO_CONN : e->connect.conn_handle;
        xTaskNotifyGive(worker);
    } else if (e->type == BLE_GAP_EVENT_DISCONNECT) {
        connection = NO_CONN;
        xTaskNotifyGive(worker);
    }
    return 0;
}

static int gatt(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *unused)
{
    uint8_t data[IO_CHUNK];
    if (conn != connection || conn == NO_CONN) return BLE_ATT_ERR_UNLIKELY;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        size_t n = xStreamBufferReceive(tx, data, sizeof(data), 0);
        return os_mbuf_append(ctxt->om, data, n) ? BLE_ATT_ERR_INSUFFICIENT_RES : 0;
    }
    uint16_t n = OS_MBUF_PKTLEN(ctxt->om);
    if (!n || n > sizeof(data)) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    if (ble_hs_mbuf_to_flat(ctxt->om, data, sizeof(data), NULL)) return BLE_ATT_ERR_UNLIKELY;
    if (xStreamBufferSpacesAvailable(rx) < n) return BLE_ATT_ERR_INSUFFICIENT_RES;
    return xStreamBufferSend(rx, data, n, 0) == n ? 0 : BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_chr_def chars[] = {
    {.uuid = &channel.u, .access_cb = gatt, .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE}, {0}};
static const struct ble_gatt_svc_def services[] = {
    {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &service.u, .characteristics = chars}, {0}};

static int tls_io(unsigned char *buf, size_t len, bool send)
{
    while (connection != NO_CONN && esp_timer_get_time() < io_deadline) {
        size_t n = send ? xStreamBufferSend(tx, buf, len, pdMS_TO_TICKS(100))
                        : xStreamBufferReceive(rx, buf, len, pdMS_TO_TICKS(100));
        if (n) return n;
    }
    return MBEDTLS_ERR_SSL_TIMEOUT;
}
static int push(void *ctx, const unsigned char *p, size_t n) { return tls_io((unsigned char *)p, n, true); }
static int pull(void *ctx, unsigned char *p, size_t n) { return tls_io(p, n, false); }
static int rng(void *unused, unsigned char *out, size_t n)
{
    esp_fill_random(out, n);
    return 0;
}

static void command(cJSON *request, cJSON *reply)
{
    const char *op = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(request, "op"));
    if (op && !strcmp(op, "wifi.scan")) {
        okou_ap_t aps[20];
        int n = okou_wifi_scan(aps, 20, 20000);
        if (n < 0) {
            cJSON_AddStringToObject(reply, "error", "scan busy");
            return;
        }
        cJSON *list = cJSON_AddArrayToObject(reply, "ssids");
        for (int i = 0; i < n; i++)
            cJSON_AddItemToArray(list, cJSON_CreateString(aps[i].ssid));
    } else if (op && !strcmp(op, "wifi.join")) {
        const char *ssid = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(request, "ssid"));
        const char *pass = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(request, "password"));
        if (!pass ||
            !okou_wifi_join(ssid, pass, cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(request, "hidden"))))
            cJSON_AddStringToObject(reply, "error", "invalid network");
        else
            cJSON_AddBoolToObject(reply, "joining", true);
    } else if (op && !strcmp(op, "wifi.status")) {
        char current[33];
        cJSON_AddStringToObject(reply, "state", okou_wifi_join_state());
        cJSON_AddStringToObject(reply, "connected",
                                okou_wifi_current(current, sizeof(current)) ? current : "");
        cJSON_AddBoolToObject(reply, "hub", okou_ws_connected());
    } else
        cJSON_AddStringToObject(reply, "error", "unknown operation");
}

static void tls_session(void)
{
    mbedtls_ssl_config conf;
    mbedtls_ssl_context ssl;
    mbedtls_ssl_config_init(&conf);
    mbedtls_ssl_init(&ssl);
    char line[640];
    if (mbedtls_ssl_config_defaults(&conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_STREAM,
                                    MBEDTLS_SSL_PRESET_DEFAULT))
        goto end;
    mbedtls_ssl_conf_min_tls_version(&conf, MBEDTLS_SSL_VERSION_TLS1_3);
    mbedtls_ssl_conf_max_tls_version(&conf, MBEDTLS_SSL_VERSION_TLS1_3);
    mbedtls_ssl_conf_tls13_key_exchange_modes(&conf, MBEDTLS_SSL_TLS1_3_KEY_EXCHANGE_MODE_PSK_EPHEMERAL);
    static const int suites[] = {MBEDTLS_TLS1_3_AES_128_GCM_SHA256, 0};
    mbedtls_ssl_conf_ciphersuites(&conf, suites);
#if defined(MBEDTLS_SSL_SESSION_TICKETS)
    mbedtls_ssl_conf_new_session_tickets(&conf, 0);
#endif
    mbedtls_ssl_conf_rng(&conf, rng, NULL);
    if (mbedtls_ssl_conf_psk(&conf, session_key, 32, (const unsigned char *)"wifi", 4) ||
        mbedtls_ssl_setup(&ssl, &conf))
        goto end;
    mbedtls_ssl_set_bio(&ssl, NULL, push, pull, NULL);
    io_deadline = esp_timer_get_time() + 45000000;
    if (mbedtls_ssl_handshake(&ssl)) goto end;
    for (;;) {
        io_deadline = esp_timer_get_time() + 180000000;
        size_t pos = 0;
        for (;;) {
            if (pos == sizeof(line) - 1 || mbedtls_ssl_read(&ssl, (unsigned char *)&line[pos], 1) != 1)
                goto end;
            if (line[pos] == '\n') break;
            pos++;
        }
        line[pos] = 0;
        cJSON *request = cJSON_Parse(line), *reply = cJSON_CreateObject();
        if (!request || !reply) {
            cJSON_Delete(request);
            cJSON_Delete(reply);
            goto end;
        }
        xSemaphoreTake(key_lock, portMAX_DELAY);
        uint8_t live_key[32];
        if (read_key(live_key) == scan_generation && !memcmp(live_key, root_key, 32) && connection != NO_CONN)
            command(request, reply);
        else
            cJSON_AddStringToObject(reply, "error", "credential revoked");
        mbedtls_platform_zeroize(live_key, sizeof(live_key));
        xSemaphoreGive(key_lock);
        cJSON_Delete(request);
        char *result = cJSON_PrintUnformatted(reply);
        cJSON_Delete(reply);
        if (!result) goto end;
        size_t len = strlen(result), offset = 0;
        while (offset < len) {
            int n = mbedtls_ssl_write(&ssl, (unsigned char *)result + offset, len - offset);
            if (n <= 0) break;
            offset += n;
        }
        free(result);
        if (offset != len || mbedtls_ssl_write(&ssl, (unsigned char *)"\n", 1) != 1) goto end;
    }
end:
    mbedtls_platform_zeroize(line, sizeof(line));
    mbedtls_ssl_free(&ssl);
    mbedtls_ssl_config_free(&conf);
}

static void radio(void *unused)
{
    worker = xTaskGetCurrentTaskHandle();
    const int64_t deadline = esp_timer_get_time() + BOOT_SCAN_MS * 1000LL;
    while (esp_timer_get_time() < deadline) {
        if (!synced || !(scan_generation = read_key(root_key))) {
            vTaskDelay(pdMS_TO_TICKS(500));
            continue;
        }
        matched = false;
        struct ble_gap_disc_params scan = {.itvl = 320, .window = 48, .passive = 0};
        int remaining_ms = (deadline - esp_timer_get_time()) / 1000;
        if (remaining_ms <= 0) break;
        int scan_ms = remaining_ms < 3000 ? remaining_ms : 3000;
        if (ble_gap_disc(address_type, scan_ms, &scan, gap_event, NULL)) {
            vTaskDelay(pdMS_TO_TICKS(500));
            continue;
        }
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(scan_ms + 100));
        ble_gap_disc_cancel();
        if (!matched || okou_ble_generation() != scan_generation) continue;
        xStreamBufferReset(rx);
        xStreamBufferReset(tx);
        struct ble_hs_adv_fields fields = {.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP,
                                           .num_uuids128 = 1,
                                           .uuids128 = &reply_uuid,
                                           .uuids128_is_complete = 1};
        struct ble_gap_adv_params adv = {.conn_mode = BLE_GAP_CONN_MODE_UND,
                                         .disc_mode = BLE_GAP_DISC_MODE_GEN};
        if (ble_gap_adv_set_fields(&fields) ||
            ble_gap_adv_start(address_type, NULL, 12000, &adv, gap_event, NULL))
            continue;
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(12500));
        ble_gap_adv_stop();
        if (connection != NO_CONN) tls_session();
        if (connection != NO_CONN) ble_gap_terminate(connection, BLE_ERR_REM_USER_CONN_TERM);
        while (connection != NO_CONN)
            vTaskDelay(pdMS_TO_TICKS(50));
        ulTaskNotifyTake(pdTRUE, 0);
        break;
    }
    // Wait for host callbacks to finish before releasing their stream buffers.
    if (nimble_port_stop() == 0 && nimble_port_deinit() == ESP_OK) {
        vStreamBufferDelete(rx);
        vStreamBufferDelete(tx);
    }
    matched = false;
    mbedtls_platform_zeroize(session_key, sizeof(session_key));
    mbedtls_platform_zeroize(root_key, sizeof(root_key));
    vTaskDelete(NULL);
}

static void on_sync(void) { synced = ble_hs_id_infer_auto(0, &address_type) == 0; }
static void on_reset(int reason)
{
    synced = false;
    connection = NO_CONN;
}
static void host_task(void *arg)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void launch_nimble(void *arg)
{
    // The USB bootstrap key takes effect on the next boot.
    rx = xStreamBufferCreate(4096, 1);
    tx = xStreamBufferCreate(4096, 1);
    if (!key_lock || !rx || !tx || psa_crypto_init() != PSA_SUCCESS || nimble_port_init() != ESP_OK) {
        ESP_LOGE("ble_wifi", "BLE initialization failed");
        vTaskDelete(NULL);
        return;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    if (ble_gatts_count_cfg(services) || ble_gatts_add_svcs(services) ||
        xTaskCreate(radio, "ble_wifi", 10240, NULL, 3, NULL) != pdPASS) {
        ESP_LOGE("ble_wifi", "BLE provisioning unavailable");
        vTaskDelete(NULL);
        return;
    }
    nimble_port_freertos_init(host_task);
    vTaskDelete(NULL);
}

void okou_ble_start(void)
{
    key_lock = xSemaphoreCreateMutex();
    if (!okou_ble_generation()) return;
    if (!key_lock || xTaskCreate(launch_nimble, "ble_init", 4096, NULL, 3, NULL) != pdPASS)
        ESP_LOGE("ble_wifi", "cannot start BLE initialization");
}
