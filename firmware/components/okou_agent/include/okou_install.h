/* SPDX-License-Identifier: MIT */
#pragma once
#include <stdbool.h>
#include "cJSON.h"
#include "esp_err.h"

#define OKOU_BOARD_KEY "board"
#define OKOU_BOARD_CAPACITY 32
#define OKOU_BL_IMAGE_PREFIX "ESPHUB2/bootloader/"
#define OKOU_OTA_CAPABILITY "bootloader-ota-v2"

esp_err_t install_op(const cJSON *args, cJSON *data, char *err, size_t errlen);
void install_resume_pending(void);
bool install_bootloader_pending(void);
