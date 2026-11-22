/* SPDX-License-Identifier: MIT */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "okou_agent.h"
#include "okou_agent_ext.h"

#define OKOU_TAG "okou"

/* ---- log ring (okou_log.c) ---- */
esp_err_t okou_log_init(void);
/* Builds one {"t":"log",...} frame from unsent lines; returns length, 0 when nothing to send. */
size_t okou_log_build_frame(char *buf, size_t cap, uint32_t through);
void okou_log_ack(int64_t seq);
void okou_log_rewind(void); /* on reconnect: resend everything not yet acked */
typedef struct {
    uint32_t last_written, last_sent, last_acked, dropped;
    size_t used, capacity;
} okou_log_stats_t;
okou_log_stats_t okou_log_stats(void);

/* ---- registry (okou_registry.c) ---- */
typedef enum { OKOU_P_INT, OKOU_P_FLOAT, OKOU_P_BOOL } okou_ptype_t;
void okou_registry_builtin_cmds(void);
cJSON *okou_cmd_list_json(void);
/* Runs a command; returns malloc'd UTF-8 output via *out_text; rc via return. -1000: unknown */
int okou_cmd_run(const char *name, const cJSON *argv, char **out_text);
cJSON *okou_param_list_json(void);
esp_err_t okou_param_get_json(const char *name, cJSON *data, char *err, size_t errlen);
esp_err_t okou_param_set_json(const cJSON *args, cJSON *data, char *err, size_t errlen);

/* ---- network (okou_net.c) ---- */
void *okou_malloc_large(size_t size);
esp_err_t okou_net_start(bool manage);
esp_err_t okou_wifi_init(void);
void okou_wifi_on_started(void);
void okou_wifi_on_got_ip(void);
void okou_wifi_on_disconnected(int reason);
void okou_wifi_reload(void);
void okou_net_reconfigure(void);
void okou_net_info(cJSON *obj); /* adds ip, rssi */
int okou_net_describe(char *buf, size_t len);

/* ---- util (okou_util.c) ---- */
/* JSON string body escape with UTF-8 sanitising; returns bytes written or -1 if no room. */
int okou_json_escape(char *dst, size_t cap, const char *src, size_t len);
void okou_utf8_sanitize(char *s);
const char *okou_reset_reason_str(void);
const char *okou_ota_state_str(const esp_partition_t *p);
void okou_mac_str(char out[18]);
void okou_hex(const uint8_t *in, size_t n, char *out);
cJSON *okou_partitions_json(void);

/* ---- agent (okou_agent.c) ---- */
void okou_agent_notify(void);
bool okou_log_pending(void);
cJSON *okou_hello_fields(void); /* hello object without "t" */
extern okou_config_t g_okou_cfg;

static inline bool okou_is_launcher(void)
{
#ifdef OKOU_LAUNCHER_BUILD
    return true;
#else
    return g_okou_cfg.role == OKOU_ROLE_LAUNCHER;
#endif
}
