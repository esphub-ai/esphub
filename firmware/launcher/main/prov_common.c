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
    const char *hub = NULL, *cid = NULL, *csec = NULL, *name = NULL, *dtok = NULL;
    /* "token": "okl_dev_..." is a hub device token; {"id","secret"} the legacy Access credentials */
    const cJSON *tokobj = cJSON_IsObject(tok) ? tok : NULL;
    bool ok = str_field(j, "hub", 99, &hub, err, n) && str_field(tokobj, "id", 95, &cid, err, n) &&
              str_field(tokobj, "secret", 99, &csec, err, n) && str_field(j, "name", 32, &name, err, n);
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
        const char *keys[] = {"hub", "cid", "csec", "name", OKOU_KEY_TOKEN};
        const char *vals[] = {hub, cid, csec, name, dtok};
        for (int i = 0; i < 5 && ok; i++) {
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

const char *prov_request_op(const char *line)
{
    static char op[16];
    op[0] = '\0';
    cJSON *j = cJSON_Parse(line);
    const cJSON *o = cJSON_GetObjectItemCaseSensitive(j, "op");
    if (cJSON_IsString(o)) {
        strlcpy(op, o->valuestring, sizeof(op));
    }
    cJSON_Delete(j);
    return op[0] ? op : NULL;
}

