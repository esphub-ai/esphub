/*
 * okou_agent - device side of the esp-launcher protocol (docs/protocol.md, v1).
 *
 * Link this component into an app, register commands/params, call okou_agent_start().
 * Nothing in this API blocks on the network: logs, metrics and events are queued into
 * bounded RAM buffers and sent by a low-priority agent task; when buffers are full, data
 * is dropped and counted instead of blocking the caller.
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once

#define OKOU_SDK_VERSION "1.0.0"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    OKOU_ROLE_APP = 0,      /* normal apps */
    OKOU_ROLE_LAUNCHER = 1, /* only the esp-launcher firmware */
} okou_role_t;

typedef struct {
    okou_role_t role;
    /* true (default): the SDK brings up the network itself (Wi-Fi STA from NVS okl/ssid+pass,
     * falling back to credentials already stored by the Wi-Fi driver; or OpenCores Ethernet
     * when CONFIG_OKOU_NET_OPENETH=y). false: the app owns esp_netif/Wi-Fi and the SDK just
     * waits for an IP address. */
    bool manage_network;
    /* false (default): command handlers run on the agent task.
     * true: `cmd` requests are queued and run inside okou_poll() on the caller's task. */
    bool handlers_in_poll;
    /* false (default): the SDK marks a freshly installed app valid once the hub acknowledged
     * its hello, and boots the launcher after CONFIG_OKOU_MAX_FAIL_BOOTS boots without a hub
     * ack. true: the app runs its own startup health check and then calls okou_app_mark_valid();
     * the SDK neither marks the app valid nor applies the fail_boots safety net. Use this for
     * devices that must keep working offline. */
    bool app_validates;
    /* Static interpreter version string, set only by the MicroPython port. */
    const char *micropython_version;
} okou_config_t;

#define OKOU_CONFIG_DEFAULT() { .role = OKOU_ROLE_APP, .manage_network = true, .handlers_in_poll = false, .app_validates = false }

/* One-call init: NVS, log tee, network (optional), agent task. cfg may be NULL (defaults).
 * For role=app it also implements the fail_boots safety net (may reboot into the launcher). */
esp_err_t okou_agent_start(const okou_config_t *cfg);

/* For app_validates apps: confirm the running image after the app's own health check. Marks a
 * PENDING_VERIFY image valid (cancelling rollback) and reports `app.valid` (by=app) to the hub,
 * queued until the hub is reachable. ESP_OK if the image is already valid or has no otadata
 * entry (flashed over USB); ESP_ERR_INVALID_STATE for an image marked invalid. */
esp_err_t okou_app_mark_valid(void);

/* True while the hub WebSocket is up and our hello has been acknowledged. */
bool okou_connected(void);

/* Hand the device to the launcher for (re-)provisioning: sets the one-shot NVS flag okl/setup
 * and reboots into the launcher, which keeps USB provisioning open and does not auto-start
 * the app until it has reached the hub again. Apps with a display call this after showing setup
 * instructions (e-paper keeps them visible). Does not return on success. */
esp_err_t okou_enter_setup(void);

/* ---- commands ---------------------------------------------------------------------- */
typedef struct okou_out okou_out_t;
/* argv[0] is the command name. Return 0 for success; non-zero makes the res ok:false with
 * the handler output (or "exit <rc>") as error. Output is capped at CONFIG_OKOU_CMD_OUT_MAX. */
typedef int (*okou_cmd_handler_t)(int argc, char **argv, okou_out_t *out);
int okou_outf(okou_out_t *out, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
esp_err_t okou_cmd_register(const char *name, const char *help, okou_cmd_handler_t handler);

/* ---- params -------------------------------------------------------------------------- */
/* The variable behind `ptr` is owned by the app and must stay valid forever. The agent
 * writes it with a single aligned 32-bit store when the operator calls param.set.
 * persist=true: value is loaded from NVS (namespace "okp", key = name, max 15 chars) at
 * registration time and saved on param.set. Names are limited to 23 chars. */
esp_err_t okou_param_int(const char *name, int32_t *ptr, int32_t min, int32_t max, bool persist);
esp_err_t okou_param_float(const char *name, float *ptr, float min, float max, bool persist);
esp_err_t okou_param_bool(const char *name, bool *ptr, bool persist);
/* Save the current value of a persistent param after the app changed it itself. */
esp_err_t okou_param_save(const char *name);

/* ---- telemetry ----------------------------------------------------------------------- */
/* Never blocks. Samples are batched (~200 ms). Oldest samples are overwritten when offline. */
void okou_metric(const char *name, double value);
/* json: a JSON object text (or NULL for {}). Invalid JSON is sent as {"text":"..."}.
 * Never blocks; dropped (and counted) when the outbound queue is full. */
void okou_event(const char *name, const char *json);

/* Only meaningful with handlers_in_poll=true: runs queued command handlers on the calling
 * task. Waits up to timeout_ms for work. Returns the number of handlers run. */
int okou_poll(uint32_t timeout_ms);

#ifdef __cplusplus
}
#endif
