/* SPDX-License-Identifier: MIT */
#pragma once
#include <stdbool.h>
#include "cJSON.h"
#include "esp_err.h"

#define OKOU_OTA_CAPABILITY "single-launcher-v1"

esp_err_t install_op(const cJSON *args, cJSON *data, char *err, size_t errlen);
void install_resume_pending(void);
bool install_launcher_pending(void);
