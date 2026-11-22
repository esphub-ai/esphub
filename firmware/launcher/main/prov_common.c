/*
 * Parse and store the local USB serial provisioning record.
 *
 * SPDX-License-Identifier: MIT
 */
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "okou_agent_ext.h"
#include "launcher.h"
#include "okou_ble.h"

static bool str_field(const cJSON *o, const char *k, size_t max, const char **out, char *err, size_t n)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
    *out = NULL;
    if (!v) {
        return true;
    }
    if (!cJSON_IsString(v) || strlen(v->valuestring) > max) {
        snprintf(err, n, "%s must be a string of at most %u chars", k, (unsigned)max);
        return false;
    }
    *out = v->valuestring;
    return true;
}

bool prov_apply(const char *line, char *err, size_t n)
{
    cJSON *j = cJSON_Parse(line);
    if (!cJSON_IsObject(j)) {
        cJSON_Delete(j);
        snprintf(err, n, "invalid JSON");
        return false;
    }
    if (cJSON_GetObjectItemCaseSensitive(j, "wifi")) {
        cJSON_Delete(j);
        snprintf(err, n, "use BLE for Wi-Fi setup");
        return false;
    }
    const cJSON *tok = cJSON_GetObjectItemCaseSensitive(j, "token");
    const char *hub = NULL, *name = NULL, *dtok = NULL;
    bool ok = str_field(j, "hub", 99, &hub, err, n) && str_field(j, "name", 32, &name, err, n);
    if (ok && tok && !cJSON_IsString(tok)) {
        snprintf(err, n, "expected a device token");
        ok = false;
    }
    if (ok && cJSON_IsString(tok)) {
        if (strncmp(tok->valuestring, "okl_dev_", 8) != 0 || strlen(tok->valuestring) > 95) {
            snprintf(err, n, "token must be a hub device token (okl_dev_...)");
            ok = false;
        } else {
            dtok = tok->valuestring;
        }
    }
#if CONFIG_OKOU_BLE_WIFI
    const cJSON *ble = cJSON_GetObjectItemCaseSensitive(j, "ble_secret");
    if (ok && ble && (!dtok || !cJSON_IsString(ble) || strlen(ble->valuestring) != 64 ||
                      strspn(ble->valuestring, "0123456789abcdef") != 64)) {
        snprintf(err, n, "invalid BLE bootstrap");
        ok = false;
    }
    if (ok && dtok) {
        char previous[96];
        if (okou_nvs_get_str(OKOU_KEY_TOKEN, previous, sizeof(previous)) != ESP_OK || strcmp(dtok, previous)) {
            ok = okou_nvs_erase("ble_key") == ESP_OK;
            if (!ok) snprintf(err, n, "BLE credential reset failed");
        }
    }
#endif
    if (ok && dtok && !hub) hub = "api.esphub.ai";
    if (ok) {
        const char *keys[] = {"hub", "name", OKOU_KEY_TOKEN};
        const char *vals[] = {hub, name, dtok};
        for (int i = 0; i < 3 && ok; i++) {
            if (vals[i] && okou_nvs_set_str(keys[i], vals[i]) != ESP_OK) {
                snprintf(err, n, "NVS write failed (%s)", keys[i]);
                ok = false;
            }
        }
    }
#if CONFIG_OKOU_BLE_WIFI
    if (ok && ble && okou_ble_install(1, ble->valuestring, true) != ESP_OK) {
        snprintf(err, n, "invalid BLE bootstrap or NVS write failed");
        ok = false;
    }
#endif
    cJSON_Delete(j);
    return ok;
}
