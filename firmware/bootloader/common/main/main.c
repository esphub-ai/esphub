/*
 * esp-bootloader: headless bootloader. Boot/rollback rules from docs/protocol.md:
 *  - auto-starts the app CONFIG_OKL_AUTOSTART_MS after boot if the app partition holds an
 *    image, unless okl/pending exists, okl/stay is set, or a hub request arrived;
 *  - resumes okl/pending after the hub acked hello;
 *
 * SPDX-License-Identifier: MIT
 */
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "okou_agent.h"
#include "okou_agent_ext.h"
#include "bootloader.h"
#include "okou_ble.h"
#include "sdkconfig.h"

static const char *TAG = "bootloader";

static volatile bool s_acked_evt;
static volatile bool s_req_seen;
static bool s_stay;

static void on_hello_acked(void)
{
    install_resume_pending();
    s_acked_evt = true;
}

static void on_request(const char *op)
{
    if (!s_req_seen) {
        s_req_seen = true;
        ESP_LOGI(TAG, "hub request (%s): app auto-start cancelled for this boot", op);
    }
}

static void param_hook(const char *name)
{
    if (strcmp(name, "stay_in_bootloader") == 0) {
        okou_nvs_set_u8(OKOU_KEY_STAY, s_stay ? 1 : 0);
    }
}

static const esp_partition_t *app_partition_with_image(void)
{
    const esp_partition_t *app = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, "app");
    esp_app_desc_t d;
    if (!app || esp_ota_get_partition_description(app, &d) != ESP_OK) {
        return NULL;
    }
    return app;
}

void app_main(void)
{
#if CONFIG_OKL_USB_CDC
    prov_usb_cdc_init();
#endif
    ESP_ERROR_CHECK(okou_nvs_init());
    const esp_partition_t *run = esp_ota_get_running_partition();
    uint8_t hold = okou_nvs_get_u8(OKOU_KEY_HOLD, 0);
    if (hold) {
        okou_nvs_erase(OKOU_KEY_HOLD);
    }
    /* okou_enter_bootloader() from the app: stay here with provisioning open until the hub acks,
     * then the first-ack resume below starts the app again. */
    uint8_t setup = okou_nvs_get_u8(OKOU_KEY_SETUP, 0);
    if (setup) {
        okou_nvs_erase(OKOU_KEY_SETUP);
    }
    s_stay = okou_nvs_get_u8(OKOU_KEY_STAY, 0) != 0;
    uint8_t fail_boots = okou_nvs_get_u8(OKOU_KEY_FAIL_BOOTS, 0);
    char *pending = okou_nvs_get_str_alloc(OKOU_KEY_PENDING);
    bool has_pending = pending != NULL;
    free(pending);
    const esp_partition_t *invalid = esp_ota_get_last_invalid_partition();
    bool app_failed = (invalid && strcmp(invalid->label, "app") == 0) || fail_boots >= 3;

    okou_param_bool("stay_in_bootloader", &s_stay, false); /* stored in okl/stay by param_hook */
    okou_param_set_hook(param_hook);
    okou_op_register("install", install_op);
    coredump_ops_register();
    okou_hooks_t hooks = {.on_hello_acked = on_hello_acked, .on_request = on_request};
    okou_set_hooks(&hooks);
    okou_config_t cfg = OKOU_CONFIG_DEFAULT();
    cfg.role = OKOU_ROLE_BOOTLOADER;
    cfg.ble_setup = setup;
    ESP_ERROR_CHECK(okou_agent_start(&cfg));

    const esp_partition_t *app = app_partition_with_image();
    ESP_LOGI(TAG, "running %s; app image %s; pending=%d stay=%d hold=%d fail_boots=%u app_failed=%d",
             run->label, app ? "present" : "absent",
             has_pending, s_stay, hold, fail_boots, app_failed);
    prov_serial_start();
    esp_ota_img_states_t st;
    if (esp_ota_get_state_partition(run, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY)
        ESP_ERROR_CHECK(esp_ota_mark_app_valid_cancel_rollback());
    ESP_ERROR_CHECK(okou_nvs_set_str(OKOU_KEY_LSLOT, run->label));
    if (hold) {
        ESP_LOGI(TAG, "held in bootloader; use USB setup or reboot target=app");
    }

    int64_t t0 = esp_timer_get_time();
    int64_t autostart_at = t0 + (app_failed ? (int64_t)CONFIG_OKL_FAILSAFE_WAIT_S * 1000000
                                            : (int64_t)CONFIG_OKL_AUTOSTART_MS * 1000);
    /* An unprovisioned device must stay in the bootloader: the app cannot provision over USB, so
     * leaving would close the setup window. The app starts after the first hub ack instead. */
    char *p_hub = okou_nvs_get_str_alloc("hub");
    char *p_tok = okou_nvs_get_str_alloc(OKOU_KEY_TOKEN);
    bool provisioned = okou_hub_host_valid(p_hub) && p_tok && p_tok[0];
    free(p_tok);
    free(p_hub);
    bool autostart = app && provisioned && !has_pending && !s_stay && !hold && !setup;
    if (setup) {
        ESP_LOGI(TAG, "setup requested by the app: provisioning open, app starts after the next hub ack");
    }
    if (app && !provisioned) {
        ESP_LOGI(TAG, "not provisioned: staying in the bootloader (USB provisioning open)");
    }
    if (autostart) {
        ESP_LOGI(TAG, "auto-starting app in %d ms unless a hub request arrives",
                 (int)((autostart_at - t0) / 1000));
    }

    bool acked_once = false;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(100));
        int64_t now = esp_timer_get_time();
        if (s_acked_evt) {
            s_acked_evt = false;
            if (!acked_once) {
                acked_once = true;
                char *still_pending = okou_nvs_get_str_alloc(OKOU_KEY_PENDING);
                bool resume = app && !still_pending && !s_stay && !hold && !s_req_seen;
                free(still_pending);
                if (resume && !autostart) {
                    autostart = true;
                    autostart_at = now + (int64_t)(app_failed ? CONFIG_OKL_FAILSAFE_WAIT_S * 1000 : CONFIG_OKL_AUTOSTART_MS) * 1000;
                    ESP_LOGI(TAG, "auto-starting app in %d ms unless a hub request arrives",
                             (int)((autostart_at - now) / 1000));
                }
            }
        }
        if (autostart && (s_req_seen || s_stay)) {
            autostart = false;
        }
#if CONFIG_OKOU_BLE_WIFI
        if (okou_ble_host_owned()) continue;
#endif
        if (autostart && now >= autostart_at) {
            autostart = false;
            okou_nvs_set_u8(OKOU_KEY_FAIL_BOOTS, 0);
            esp_err_t e = esp_ota_set_boot_partition(app);
            if (e == ESP_OK) {
                ESP_LOGI(TAG, "starting app");
                okou_schedule_reboot(100);
            } else {
                ESP_LOGE(TAG, "app image not bootable: %s", esp_err_to_name(e));
            }
        }
    }
}
