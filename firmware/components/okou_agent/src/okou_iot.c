/* SPDX-License-Identifier: MIT */
#include "okou_priv.h"
#include "okou_iot.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "mqtt_client.h"
#include "esp_crt_bundle.h"
#include "esp_random.h"
#include "mbedtls/pk.h"
#include "mbedtls/x509_csr.h"

static esp_mqtt_client_handle_t mqtt;
static cJSON *active_identity, *active_certificate;
static unsigned events;
static char topic[64];
static portMUX_TYPE event_lock = portMUX_INITIALIZER_UNLOCKED;
static void signal_event(unsigned mask)
{
    portENTER_CRITICAL(&event_lock);
    events |= mask;
    portEXIT_CRITICAL(&event_lock);
}
unsigned okou_iot_events(void)
{
    portENTER_CRITICAL(&event_lock);
    unsigned mask = events;
    events = 0;
    portEXIT_CRITICAL(&event_lock);
    return mask;
}
typedef struct {
    char *data;
    size_t len, limit;
    bool overflow;
} response_t;
static esp_err_t receive(esp_http_client_event_t *e)
{
    response_t *r = e->user_data;
    if (e->event_id == HTTP_EVENT_ON_DATA && e->data_len > 0) {
        if ((size_t)e->data_len > r->limit - r->len) {
            r->overflow = true;
            return ESP_FAIL;
        }
        memcpy(r->data + r->len, e->data, e->data_len);
        r->len += e->data_len;
    }
    return ESP_OK;
}
static cJSON *post(const char *operation, cJSON *body, int *status)
{
    char base[160], url[224];
    if (!body || okou_hub_http_base(base, sizeof(base)) != ESP_OK || strncmp(base, "https://", 8))
        return NULL;
    snprintf(url, sizeof(url), "%s/api/device/iot/%s", base, operation);
    response_t r = {.limit = 16384};
    r.data = okou_malloc_large(r.limit + 1);
    char *payload = cJSON_PrintUnformatted(body);
    cJSON *answer = NULL;
    if (r.data && payload) {
        esp_http_client_config_t cfg = {.url = url,
                                        .method = HTTP_METHOD_POST,
                                        .crt_bundle_attach = esp_crt_bundle_attach,
                                        .disable_auto_redirect = true,
                                        .timeout_ms = 10000,
                                        .event_handler = receive,
                                        .user_data = &r};
        esp_http_client_handle_t client = esp_http_client_init(&cfg);
        if (client) {
            okou_http_apply_auth(client);
            esp_http_client_set_header(client, "Content-Type", "application/json");
            esp_http_client_set_post_field(client, payload, strlen(payload));
            if (esp_http_client_perform(client) == ESP_OK) {
                *status = esp_http_client_get_status_code(client);
                r.data[r.len] = 0;
                if (*status == 200 && !r.overflow)
                    answer = cJSON_Parse(r.data);
            }
            esp_http_client_cleanup(client);
        }
    }
    free(payload);
    free(r.data);
    return answer;
}
cJSON *okou_iot_post(const char *operation, cJSON *body)
{
    int status = 0;
    return post(operation, body, &status);
}
int okou_iot_available(void)
{
    cJSON *empty = cJSON_CreateObject();
    int status = 0;
    cJSON *reply = post("capabilities", empty, &status);
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(reply, "mqtt");
    int available = cJSON_IsBool(value) ? cJSON_IsTrue(value) : (status == 404 ? 0 : -1);
    cJSON_Delete(empty);
    cJSON_Delete(reply);
    return available;
}
static int hardware_random(void *ctx, unsigned char *buf, size_t len)
{
    (void)ctx;
    esp_fill_random(buf, len);
    return 0;
}
/* Save key and original CSR together so a retry uses the identical enrollment. */
static cJSON *identity(void)
{
    char *saved = okou_nvs_get_str_alloc("mqtt_identity");
    if (saved) {
        cJSON *id = cJSON_Parse(saved);
        free(saved);
        return id;
    }
    mbedtls_pk_context key;
    mbedtls_x509write_csr csr;
    mbedtls_pk_init(&key);
    mbedtls_x509write_csr_init(&csr);
    unsigned char *pem = calloc(1, 1024);
    cJSON *id = NULL;
    if (!pem || mbedtls_pk_setup(&key, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) ||
        mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, mbedtls_pk_ec(key), hardware_random, NULL) ||
        mbedtls_pk_write_key_pem(&key, pem, 1024))
        goto done;
    id = cJSON_CreateObject();
    if (!id || !cJSON_AddStringToObject(id, "key", (char *)pem))
        goto failed;
    mbedtls_x509write_csr_set_key(&csr, &key);
    mbedtls_x509write_csr_set_md_alg(&csr, MBEDTLS_MD_SHA256);
    if (mbedtls_x509write_csr_set_subject_name(&csr, "CN=ESPHub device") ||
        mbedtls_x509write_csr_pem(&csr, pem, 1024, hardware_random, NULL) ||
        !cJSON_AddStringToObject(id, "csr", (char *)pem))
        goto failed;
    char *encoded = cJSON_PrintUnformatted(id);
    bool stored = encoded && okou_nvs_set_str("mqtt_identity", encoded) == ESP_OK;
    free(encoded);
    if (stored)
        goto done;
failed:
    cJSON_Delete(id);
    id = NULL;
done:
    free(pem);
    mbedtls_x509write_csr_free(&csr);
    mbedtls_pk_free(&key);
    return id;
}
static void mqtt_event(void *ctx, esp_event_base_t base, int32_t event, void *arg)
{
    esp_mqtt_event_handle_t e = arg;
    switch (event) {
    case MQTT_EVENT_CONNECTED:
        if (esp_mqtt_client_subscribe(e->client, topic, 1) < 0)
            signal_event(IOT_OFFLINE);
        break;
    case MQTT_EVENT_SUBSCRIBED:
        signal_event(IOT_SUBSCRIBED | IOT_WAKE);
        break;
    case MQTT_EVENT_DATA:
        signal_event(IOT_WAKE);
        break;
    case MQTT_EVENT_DISCONNECTED:
        signal_event(IOT_OFFLINE);
        break;
    default:
        break;
    }
}
void okou_iot_stop(void)
{
    if (mqtt) {
        esp_mqtt_client_destroy(mqtt);
        mqtt = NULL;
    }
    cJSON_Delete(active_identity);
    active_identity = NULL;
    cJSON_Delete(active_certificate);
    active_certificate = NULL;
    okou_iot_events();
}
bool okou_iot_start(void)
{
    cJSON *id = identity(), *req = cJSON_CreateObject(), *reply = NULL;
    const char *key = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(id, "key"));
    const char *csr = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(id, "csr"));
    bool started = false;
    if (!key || !csr || !cJSON_AddStringToObject(req, "csr", csr))
        goto done;
    reply = okou_iot_post("enroll", req);
    const char *device = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(reply, "device_id"));
    const char *host = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(reply, "endpoint"));
    const char *cert = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(reply, "certificate"));
    if (!device || strlen(device) != 36 || !host || !cert)
        goto done;
    char client_id[48];
    snprintf(client_id, sizeof(client_id), "esphub-%s", device);
    snprintf(topic, sizeof(topic), "devices/%s/wake", device);
    esp_mqtt_client_config_t config = {
        .broker.address.hostname = host,
        .broker.address.port = 8883,
        .broker.address.transport = MQTT_TRANSPORT_OVER_SSL,
        .broker.verification.crt_bundle_attach = esp_crt_bundle_attach,
        .credentials.client_id = client_id,
        .credentials.authentication.certificate = cert,
        .credentials.authentication.key = key,
        .session.keepalive = 300,
        .network.disable_auto_reconnect = true,
    };
    mqtt = esp_mqtt_client_init(&config);
    if (mqtt && esp_mqtt_client_register_event(mqtt, ESP_EVENT_ANY_ID, mqtt_event, NULL) == ESP_OK &&
        esp_mqtt_client_start(mqtt) == ESP_OK)
        started = true;
    if (!started)
        okou_iot_stop();
    else {
        active_identity = id;
        active_certificate = reply;
        id = reply = NULL;
    }
done:
    cJSON_Delete(req);
    cJSON_Delete(reply);
    cJSON_Delete(id);
    return started;
}
