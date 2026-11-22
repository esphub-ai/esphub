#pragma once
#include "sdkconfig.h"
#if CONFIG_OKOU_BLE_WIFI
#include "esp_err.h"
#include <stdbool.h>
void okou_ble_start(void);
unsigned okou_ble_generation(void);
esp_err_t okou_ble_install(unsigned generation, const char *hex, bool usb);
bool okou_ble_busy(void);
#endif
