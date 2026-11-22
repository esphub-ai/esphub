/* SPDX-License-Identifier: MIT */
#pragma once
#include <stdbool.h>
#include "esp_err.h"
#include "esp_partition.h"
#include "cJSON.h"

esp_err_t install_op(const cJSON *args, cJSON *data, char *err, size_t errlen);
void install_resume_pending(void); /* after the hub acked hello */
bool install_running(void);
const esp_partition_t *launcher_inactive_slot(void);

void coredump_ops_register(void);

/* Store a provisioning JSON object (BLE bootstrap key/hub/token/name) in NVS namespace okl. */
bool prov_apply(const char *line, char *err, size_t n);
/* {"op":"scan"} / {"op":"saved"} requests from the setup page; NULL for a provisioning payload. */
const char *prov_request_op(const char *line);
/* USB-serial provisioning: a console line "OKL-PROVISION <json>" applies the same payload. */
void prov_serial_start(void);
