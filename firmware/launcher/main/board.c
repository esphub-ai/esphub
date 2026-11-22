/*
 * Board bring-up run first in app_main.
 *
 * M5Stack StopWatch (CONFIG_OKL_BOARD_M5_STOPWATCH): the M5PM1 power manager (I2C 0x6E on
 * SDA 47 / SCL 48) clears its power-hold register on every reset. Without re-asserting it the
 * device can drop power on battery, and its watchdog/I2C-sleep defaults must be neutralised.
 * Register map from m5stack/M5PM1 1.0.6 (the version e7h4n/coffee-watch pins):
 *   0x07 HOLD_CFG bit5 = LDO hold, 0x09 I2C_CFG low nibble = sleep timeout (0 = off),
 *   0x0A WDT_CNT (0 = off). Power-key behavior belongs to the PMIC.
 * The bus is released afterwards so apps can initialise the board their own way.
 *
 * SPDX-License-Identifier: MIT
 */
#include "sdkconfig.h"
#include "esp_log.h"
#include "launcher.h"
#if CONFIG_OKL_BOARD_M5_STOPWATCH
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"

static const char *TAG = "board";
#define PM1_ADDR 0x6E

static bool rmw(i2c_master_dev_handle_t d, uint8_t reg, uint8_t clear, uint8_t set)
{
    uint8_t v = 0;
    if (i2c_master_transmit_receive(d, &reg, 1, &v, 1, 50) != ESP_OK) {
        return false;
    }
    uint8_t nv = (uint8_t)((v & ~clear) | set);
    uint8_t buf[2] = {reg, nv};
    return nv == v || i2c_master_transmit(d, buf, 2, 50) == ESP_OK;
}

void board_init(void)
{
    i2c_master_bus_config_t bc = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = GPIO_NUM_47,
        .scl_io_num = GPIO_NUM_48,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus = NULL;
    if (i2c_new_master_bus(&bc, &bus) != ESP_OK) {
        ESP_LOGW(TAG, "stopwatch: i2c bus init failed");
        return;
    }
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = PM1_ADDR, .scl_speed_hz = 100000};
    i2c_master_dev_handle_t pm1 = NULL;
    bool ok = false;
    if (i2c_master_bus_add_device(bus, &dc, &pm1) == ESP_OK) {
        for (int attempt = 0; attempt < 3 && !ok; attempt++) {
            (void)i2c_master_probe(bus, PM1_ADDR, 20); /* START on SDA wakes a sleeping PM1 */
            vTaskDelay(pdMS_TO_TICKS(10));
            ok = rmw(pm1, 0x07, 0, 1 << 5) &&  /* power hold (LDO) */
                 rmw(pm1, 0x09, 0x0F, 0) &&    /* I2C sleep off */
                 rmw(pm1, 0x0A, 0xFF, 0);      /* PMIC watchdog off */
            if (!ok) {
                vTaskDelay(pdMS_TO_TICKS(attempt == 0 ? 50 : 800));
            }
        }
        i2c_master_bus_rm_device(pm1);
    }
    i2c_del_master_bus(bus);
    if (ok) {
        ESP_LOGI(TAG, "stopwatch: PM1 power hold on, watchdog off");
    } else {
        ESP_LOGW(TAG, "stopwatch: PM1 not reachable; power hold NOT set (keep USB power attached)");
    }
}
#else
void board_init(void)
{
}
#endif
