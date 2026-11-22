/*
 * USB-serial provisioning: a console line `OKL-PROVISION <json>` stores the same payload as
 * BLE provisioning (docs/protocol.md). Used for the first USB flash, when the operator already
 * has a cable attached. The line is never echoed or logged. Physical USB access already implies
 * full control of the device (esptool can rewrite flash), so this adds no new exposure.
 *
 * SPDX-License-Identifier: MIT
 */
#include <stdio.h>
#include <string.h>
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "okou_agent_ext.h"
#include "launcher.h"
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#elif CONFIG_ESP_CONSOLE_UART
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#endif

static const char *TAG = "prov_serial";
#define PREFIX "OKL-PROVISION "
#define PROV_LINE_MAX 640

static void serial_task(void *arg)
{
    static char line[PROV_LINE_MAX];
    size_t len = 0;
    bool overflow = false;
    for (;;) {
        int c = fgetc(stdin);
        if (c == EOF) {
            clearerr(stdin);
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        if (c == '\r') {
            continue;
        }
        if (c != '\n') {
            if (len < PROV_LINE_MAX - 1) {
                line[len++] = (char)c;
            } else {
                overflow = true;
            }
            continue;
        }
        line[len] = '\0';
        if (strncmp(line, PREFIX, strlen(PREFIX)) == 0) {
            char err[96] = "";
            if (overflow) {
                printf("OKL-PROVISION-ERR line too long\n");
            } else if (prov_apply(line + strlen(PREFIX), err, sizeof(err))) {
                ESP_LOGI(TAG, "provisioning data stored (usb serial)");
                printf("OKL-PROVISION-OK\n");
                okou_net_reconfigure();
                okou_agent_reload_config();
            } else {
                printf("OKL-PROVISION-ERR %s\n", err);
            }
        }
        memset(line, 0, sizeof(line));
        len = 0;
        overflow = false;
    }
}

void prov_serial_start(void)
{
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    if (usb_serial_jtag_driver_install(&cfg) != ESP_OK) {
        ESP_LOGW(TAG, "usb serial driver install failed; serial provisioning unavailable");
        return;
    }
    usb_serial_jtag_vfs_use_driver();
#elif CONFIG_ESP_CONSOLE_UART
    if (uart_driver_install(CONFIG_ESP_CONSOLE_UART_NUM, 1024, 0, 0, NULL, 0) != ESP_OK) {
        ESP_LOGW(TAG, "uart driver install failed; serial provisioning unavailable");
        return;
    }
    uart_vfs_dev_use_driver(CONFIG_ESP_CONSOLE_UART_NUM);
#else
    return;
#endif
    setvbuf(stdin, NULL, _IONBF, 0);
    xTaskCreate(serial_task, "okl_serial", 4096, NULL, 2, NULL);
}
