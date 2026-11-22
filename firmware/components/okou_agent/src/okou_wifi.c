/* Wi-Fi manager for SDK-managed networking (launcher and apps with manage_network=true).
 *
 *  - Remembers up to OKOU_WIFI_MAX networks in NVS okl/wifis (JSON, most recently used first).
 *    okl/ssid + okl/pass keep mirroring the first entry so older launchers still get online.
 *  - Connect loop (own task): scan, try saved networks that are visible (strongest first), then
 *    the rest including hidden ones (direct connect by SSID), back off when nothing works, and
 *    wait for a disconnect once online.
 *  - okou_wifi_scan() is serialised with connection attempts through one radio mutex.
 *
 * SPDX-License-Identifier: MIT */
#include <string.h>
#include <stdlib.h>
#include "sdkconfig.h"
#include "okou_priv.h"
#include "okou_agent_ext.h"

#if !CONFIG_OKOU_NET_OPENETH
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/event_groups.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "cJSON.h"

typedef struct {
    char ssid[33];
    char pass[65];
    bool hidden;
} net_t;

#define EV_STARTED BIT0
#define EV_GOT_IP BIT1
#define EV_DISC BIT2
#define EV_RECONF BIT3
#define ATTEMPT_TIMEOUT_MS 15000
#define SCAN_MAX 24

static net_t s_nets[OKOU_WIFI_MAX];
static int s_count;
static SemaphoreHandle_t s_list_mu;  /* s_nets */
static SemaphoreHandle_t s_radio_mu; /* scan vs connection attempt */
static EventGroupHandle_t s_ev;
static volatile bool s_online;
static char s_current[33];
static volatile int s_last_reason;

static void lock(void) { xSemaphoreTake(s_list_mu, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_list_mu); }

static void save_locked(void)
{
    cJSON *arr = cJSON_CreateArray();
    for (int i = 0; i < s_count; i++) {
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "s", s_nets[i].ssid);
        cJSON_AddStringToObject(o, "p", s_nets[i].pass);
        if (s_nets[i].hidden) {
            cJSON_AddBoolToObject(o, "h", true);
        }
        cJSON_AddItemToArray(arr, o);
    }
    char *js = cJSON_PrintUnformatted(arr);
    cJSON_Delete(arr);
    if (js) {
        okou_nvs_set_str(OKOU_KEY_WIFIS, js);
        free(js);
    }
    if (s_count > 0) { /* legacy mirror for launchers before multi-network support */
        okou_nvs_set_str("ssid", s_nets[0].ssid);
        okou_nvs_set_str("pass", s_nets[0].pass);
    } else {
        okou_nvs_erase("ssid");
        okou_nvs_erase("pass");
    }
}

static void load(void)
{
    lock();
    s_count = 0;
    char *js = okou_nvs_get_str_alloc(OKOU_KEY_WIFIS);
    if (js) {
        cJSON *arr = cJSON_Parse(js);
        free(js);
        cJSON *o;
        cJSON_ArrayForEach(o, arr)
        {
            const cJSON *s = cJSON_GetObjectItemCaseSensitive(o, "s");
            const cJSON *p = cJSON_GetObjectItemCaseSensitive(o, "p");
            if (!cJSON_IsString(s) || !s->valuestring[0] || s_count >= OKOU_WIFI_MAX) {
                continue;
            }
            net_t *n = &s_nets[s_count++];
            memset(n, 0, sizeof(*n));
            strlcpy(n->ssid, s->valuestring, sizeof(n->ssid));
            strlcpy(n->pass, cJSON_IsString(p) ? p->valuestring : "", sizeof(n->pass));
            n->hidden = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(o, "h"));
        }
        cJSON_Delete(arr);
    } else {
        /* migrate the single legacy network, or what the Wi-Fi driver already stored */
        net_t n = {0};
        if (okou_nvs_get_str("ssid", n.ssid, sizeof(n.ssid)) == ESP_OK && n.ssid[0]) {
            okou_nvs_get_str("pass", n.pass, sizeof(n.pass));
        } else {
            wifi_config_t wc = {0};
            if (esp_wifi_get_config(WIFI_IF_STA, &wc) == ESP_OK && wc.sta.ssid[0]) {
                strlcpy(n.ssid, (char *)wc.sta.ssid, sizeof(n.ssid));
                strlcpy(n.pass, (char *)wc.sta.password, sizeof(n.pass));
            }
        }
        if (n.ssid[0]) {
            s_nets[s_count++] = n;
            save_locked();
            ESP_LOGI(OKOU_TAG, "wifi: migrated saved network %s", n.ssid);
        }
    }
    unlock();
}

int okou_wifi_count(void)
{
    return s_count;
}

esp_err_t okou_wifi_add(const char *ssid, const char *pass, bool hidden)
{
    if (!ssid || !ssid[0] || strlen(ssid) > 32 || (pass && strlen(pass) > 64)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_list_mu) {
        return ESP_ERR_INVALID_STATE;
    }
    lock();
    net_t n = {0};
    strlcpy(n.ssid, ssid, sizeof(n.ssid));
    strlcpy(n.pass, pass ? pass : "", sizeof(n.pass));
    n.hidden = hidden;
    int w = 1;
    net_t kept[OKOU_WIFI_MAX];
    kept[0] = n;
    for (int i = 0; i < s_count && w < OKOU_WIFI_MAX; i++) {
        if (strcmp(s_nets[i].ssid, ssid) != 0) {
            kept[w++] = s_nets[i];
        }
    }
    memcpy(s_nets, kept, sizeof(net_t) * w);
    s_count = w;
    save_locked();
    unlock();
    ESP_LOGI(OKOU_TAG, "wifi: saved %s%s (%d networks)", ssid, hidden ? " (hidden)" : "", w);
    xEventGroupSetBits(s_ev, EV_RECONF);
    return ESP_OK;
}

esp_err_t okou_wifi_forget(const char *ssid)
{
    if (!s_list_mu) {
        return ESP_ERR_INVALID_STATE;
    }
    lock();
    int w = 0;
    for (int i = 0; i < s_count; i++) {
        if (strcmp(s_nets[i].ssid, ssid) != 0) {
            s_nets[w++] = s_nets[i];
        }
    }
    bool found = w != s_count;
    s_count = w;
    if (found) {
        save_locked();
    }
    unlock();
    if (!found) {
        return ESP_ERR_NOT_FOUND;
    }
    ESP_LOGI(OKOU_TAG, "wifi: forgot %s (%d networks left)", ssid, w);
    xEventGroupSetBits(s_ev, EV_RECONF);
    return ESP_OK;
}

void okou_wifi_saved_json(cJSON *arr)
{
    if (!s_list_mu) {
        return;
    }
    lock();
    for (int i = 0; i < s_count; i++) {
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "ssid", s_nets[i].ssid);
        cJSON_AddBoolToObject(o, "hidden", s_nets[i].hidden);
        cJSON_AddBoolToObject(o, "open", s_nets[i].pass[0] == '\0');
        cJSON_AddBoolToObject(o, "current", s_online && strcmp(s_current, s_nets[i].ssid) == 0);
        cJSON_AddItemToArray(arr, o);
    }
    unlock();
}

const char *okou_wifi_auth_str(int auth)
{
    switch (auth) {
    case WIFI_AUTH_OPEN: return "open";
    case WIFI_AUTH_WEP: return "wep";
    case WIFI_AUTH_WPA_PSK: return "wpa";
    case WIFI_AUTH_WPA2_PSK: return "wpa2";
    case WIFI_AUTH_WPA_WPA2_PSK: return "wpa/wpa2";
    case WIFI_AUTH_WPA3_PSK: return "wpa3";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "wpa2/wpa3";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "enterprise";
    default: return "other";
    }
}

static int cmp_rssi(const void *a, const void *b)
{
    return ((const okou_ap_t *)b)->rssi - ((const okou_ap_t *)a)->rssi;
}

/* Caller holds s_radio_mu. Returns visible networks, one entry per SSID (strongest). */
static int scan_locked(okou_ap_t *out, int max)
{
    wifi_scan_config_t sc = {
        .show_hidden = false,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
        .scan_time.active = {.min = 60, .max = 120},
    };
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) {
        return -1;
    }
    uint16_t n = SCAN_MAX;
    wifi_ap_record_t *recs = calloc(SCAN_MAX, sizeof(*recs));
    if (!recs) {
        esp_wifi_clear_ap_list();
        return -1;
    }
    esp_wifi_scan_get_ap_records(&n, recs);
    int m = 0;
    for (int i = 0; i < n; i++) {
        const char *ssid = (const char *)recs[i].ssid;
        if (!ssid[0]) {
            continue;
        }
        int j = 0;
        while (j < m && strcmp(out[j].ssid, ssid) != 0) {
            j++;
        }
        if (j < m) {
            if (recs[i].rssi > out[j].rssi) {
                out[j].rssi = recs[i].rssi;
                out[j].channel = recs[i].primary;
            }
            continue;
        }
        if (m >= max) {
            continue;
        }
        strlcpy(out[m].ssid, ssid, sizeof(out[m].ssid));
        out[m].rssi = recs[i].rssi;
        out[m].channel = recs[i].primary;
        out[m].auth = recs[i].authmode;
        m++;
    }
    free(recs);
    qsort(out, m, sizeof(*out), cmp_rssi);
    return m;
}

int okou_wifi_scan(okou_ap_t *out, int max, uint32_t timeout_ms)
{
    if (!s_radio_mu || xSemaphoreTake(s_radio_mu, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return -1;
    }
    int n = scan_locked(out, max);
    xSemaphoreGive(s_radio_mu);
    return n;
}

bool okou_wifi_current(char *ssid, size_t len)
{
    if (!s_online) {
        return false;
    }
    strlcpy(ssid, s_current, len);
    return true;
}

/* ---- events from okou_net.c ---- */
void okou_wifi_on_started(void) { if (s_ev) xEventGroupSetBits(s_ev, EV_STARTED); }
void okou_wifi_on_got_ip(void) { if (s_ev) xEventGroupSetBits(s_ev, EV_GOT_IP); }
void okou_wifi_on_disconnected(int reason)
{
    s_last_reason = reason;
    s_online = false;
    if (s_ev) {
        xEventGroupSetBits(s_ev, EV_DISC);
    }
}
void okou_wifi_reload(void)
{
    load();
    if (s_ev) {
        xEventGroupSetBits(s_ev, EV_RECONF);
    }
}

static bool attempt(const net_t *n)
{
    wifi_config_t wc = {0};
    strlcpy((char *)wc.sta.ssid, n->ssid, sizeof(wc.sta.ssid));
    strlcpy((char *)wc.sta.password, n->pass, sizeof(wc.sta.password));
    wc.sta.threshold.authmode = n->pass[0] ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
    wc.sta.scan_method = WIFI_ALL_CHANNEL_SCAN; /* also finds hidden SSIDs (directed probe) */
    wc.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    wc.sta.pmf_cfg.capable = true;
    wc.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
    esp_wifi_set_config(WIFI_IF_STA, &wc);
    xEventGroupClearBits(s_ev, EV_GOT_IP | EV_DISC);
    ESP_LOGI(OKOU_TAG, "wifi: trying %s%s", n->ssid, n->hidden ? " (hidden)" : "");
    if (esp_wifi_connect() != ESP_OK) {
        return false;
    }
    EventBits_t b = xEventGroupWaitBits(s_ev, EV_GOT_IP | EV_DISC, pdTRUE, pdFALSE, pdMS_TO_TICKS(ATTEMPT_TIMEOUT_MS));
    if (b & EV_GOT_IP) {
        strlcpy(s_current, n->ssid, sizeof(s_current));
        s_online = true;
        return true;
    }
    ESP_LOGW(OKOU_TAG, "wifi: %s failed (%s reason %d)", n->ssid, (b & EV_DISC) ? "disconnect" : "timeout",
             s_last_reason);
    esp_wifi_disconnect();
    xEventGroupWaitBits(s_ev, EV_DISC, pdTRUE, pdFALSE, pdMS_TO_TICKS(1000));
    return false;
}

static void wifi_task(void *arg)
{
    xEventGroupWaitBits(s_ev, EV_STARTED, pdFALSE, pdFALSE, portMAX_DELAY);
    uint32_t backoff_ms = 2000;
    okou_ap_t *seen = calloc(SCAN_MAX, sizeof(okou_ap_t));
    for (;;) {
        if (s_online) {
            EventBits_t b = xEventGroupWaitBits(s_ev, EV_DISC | EV_RECONF, pdTRUE, pdFALSE, portMAX_DELAY);
            if ((b & EV_RECONF) && !(b & EV_DISC)) {
                bool still_saved = false;
                lock();
                for (int i = 0; i < s_count; i++) {
                    still_saved |= strcmp(s_nets[i].ssid, s_current) == 0;
                }
                unlock();
                if (still_saved) {
                    continue; /* keep the working connection */
                }
                ESP_LOGI(OKOU_TAG, "wifi: current network %s was forgotten, reconnecting", s_current);
                s_online = false;
                esp_wifi_disconnect();
                xEventGroupWaitBits(s_ev, EV_DISC, pdTRUE, pdFALSE, pdMS_TO_TICKS(2000));
            }
            backoff_ms = 2000;
        }
        lock();
        int count = s_count;
        net_t nets[OKOU_WIFI_MAX];
        memcpy(nets, s_nets, sizeof(net_t) * count);
        unlock();
        if (count == 0) {
            ESP_LOGW(OKOU_TAG, "no Wi-Fi credentials (provision over USB from the launcher)");
            xEventGroupWaitBits(s_ev, EV_RECONF, pdTRUE, pdFALSE, portMAX_DELAY);
            continue;
        }

        xSemaphoreTake(s_radio_mu, portMAX_DELAY);
        int nseen = seen ? scan_locked(seen, SCAN_MAX) : -1;
        /* order: visible saved networks by signal, then the rest (hidden / not seen) in saved order */
        int order[OKOU_WIFI_MAX], k = 0;
        bool used[OKOU_WIFI_MAX] = {0};
        for (int j = 0; j < nseen; j++) {
            for (int i = 0; i < count; i++) {
                if (!used[i] && strcmp(nets[i].ssid, seen[j].ssid) == 0) {
                    order[k++] = i;
                    used[i] = true;
                }
            }
        }
        for (int i = 0; i < count; i++) {
            if (!used[i]) {
                order[k++] = i;
            }
        }
        bool ok = false;
        for (int x = 0; x < k && !ok; x++) {
            ok = attempt(&nets[order[x]]);
        }
        xSemaphoreGive(s_radio_mu);

        if (ok) {
            backoff_ms = 2000;
            /* most recently used first */
            lock();
            if (s_count > 1 && strcmp(s_nets[0].ssid, s_current) != 0) {
                for (int i = 1; i < s_count; i++) {
                    if (strcmp(s_nets[i].ssid, s_current) == 0) {
                        net_t t = s_nets[i];
                        memmove(&s_nets[1], &s_nets[0], sizeof(net_t) * i);
                        s_nets[0] = t;
                        save_locked();
                        break;
                    }
                }
            }
            unlock();
            continue;
        }
        ESP_LOGW(OKOU_TAG, "wifi: no saved network reachable (%d saved, %d visible), retry in %u s", count,
                 nseen < 0 ? 0 : nseen, (unsigned)(backoff_ms / 1000));
        xEventGroupWaitBits(s_ev, EV_RECONF, pdTRUE, pdFALSE, pdMS_TO_TICKS(backoff_ms));
        if (backoff_ms < 60000) {
            backoff_ms *= 2;
        }
    }
}

esp_err_t okou_wifi_init(void)
{
    s_list_mu = xSemaphoreCreateMutex();
    s_radio_mu = xSemaphoreCreateMutex();
    s_ev = xEventGroupCreate();
    if (!s_list_mu || !s_radio_mu || !s_ev) {
        return ESP_ERR_NO_MEM;
    }
    load();
    return xTaskCreate(wifi_task, "okou_wifi", 4096, NULL, 3, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

#else /* QEMU / OpenCores Ethernet: no Wi-Fi */
int okou_wifi_count(void) { return 0; }
esp_err_t okou_wifi_add(const char *ssid, const char *pass, bool hidden) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t okou_wifi_forget(const char *ssid) { return ESP_ERR_NOT_SUPPORTED; }
void okou_wifi_saved_json(cJSON *arr) { (void)arr; }
int okou_wifi_scan(okou_ap_t *out, int max, uint32_t timeout_ms) { return -1; }
bool okou_wifi_current(char *ssid, size_t len) { return false; }
const char *okou_wifi_auth_str(int auth) { return "n/a"; }
#endif
