/*
 * esp-launcher Python runtime: the `okou` MicroPython module and the C start hook.
 *
 * C side (before MicroPython starts): okl_runtime_start() starts the okou_agent SDK, which owns
 * Wi-Fi, the hub connection, logs, commands and installs, and registers the interpreter ops:
 *   py.exec      {code, eval?}  run code in __main__ (between bytecodes of the running script),
 *                               reply {output, result, exception}
 *   py.interrupt               KeyboardInterrupt in the running code
 *   py.reset                   soft reset: interrupt, then boot.py / main.py run again
 *   py.safe_boot               reboot once without running main.py
 *   term.write   {data}        raw REPL input (Ctrl-C interrupts running code)
 * Python side: okou.term() is the dupterm stream (print() and REPL output -> hub log),
 * okou.connected(), okou.event(name, json=None), okou.metric(name, value), okou.safe_boot().
 *
 * SPDX-License-Identifier: MIT
 */
#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_netif_sntp.h"
#include "cJSON.h"

#include "py/runtime.h"
#include "py/stream.h"
#include "py/mphal.h"
#include "py/builtin.h"
#include "py/ringbuf.h"
#include "shared/runtime/interrupt_char.h"
#include "shared/readline/readline.h" /* CHAR_CTRL_C */

#include "okou_agent.h"
#include "okou_agent_ext.h"

static const char *TAG = "okl_py";

void mp_hal_wake_main_task(void);

#define OUT_CAP     8192 /* captured py.exec output */
#define RESULT_CAP  2048
#define LINE_CAP    240

/* ------------------------------------------------------------------ terminal (dupterm) */

static char s_line[LINE_CAP];
static size_t s_line_len;

static char *s_cap;       /* py.exec capture buffer (PSRAM), active while s_capturing */
static size_t s_cap_len;
static bool s_cap_trunc;
static bool s_capturing;

static void line_flush(void)
{
    if (s_line_len) {
        okou_log_text('O', s_line, s_line_len);
        s_line_len = 0;
    }
}

static void term_out(const char *buf, size_t n)
{
    if (s_capturing && s_cap) {
        size_t room = OUT_CAP - 1 - s_cap_len;
        size_t k = n < room ? n : room;
        memcpy(s_cap + s_cap_len, buf, k);
        s_cap_len += k;
        if (k < n) {
            s_cap_trunc = true;
        }
    }
    for (size_t i = 0; i < n; i++) {
        char c = buf[i];
        if (c == '\r') {
            continue;
        }
        if (c == '\n') {
            line_flush();
            continue;
        }
        if (s_line_len == LINE_CAP) {
            line_flush();
        }
        s_line[s_line_len++] = c;
    }
}

typedef struct {
    mp_obj_base_t base;
} term_obj_t;

static mp_uint_t term_read(mp_obj_t self, void *buf, mp_uint_t size, int *errcode)
{
    /* Hub input goes straight into stdin_ringbuf (term.write). Never return 0 here: dupterm
     * treats 0 as EOF and detaches the stream. */
    *errcode = MP_EAGAIN;
    return MP_STREAM_ERROR;
}

static mp_uint_t term_write(mp_obj_t self, const void *buf, mp_uint_t size, int *errcode)
{
    term_out(buf, size);
    return size;
}

static mp_uint_t term_ioctl(mp_obj_t self, mp_uint_t request, uintptr_t arg, int *errcode)
{
    if (request == MP_STREAM_POLL) {
        return arg & MP_STREAM_POLL_WR;
    }
    if (request == MP_STREAM_CLOSE || request == MP_STREAM_FLUSH) {
        return 0;
    }
    *errcode = MP_EINVAL;
    return MP_STREAM_ERROR;
}

static const mp_stream_p_t term_stream_p = {
    .read = term_read,
    .write = term_write,
    .ioctl = term_ioctl,
};

static const mp_rom_map_elem_t term_locals_table[] = {
    { MP_ROM_QSTR(MP_QSTR_read), MP_ROM_PTR(&mp_stream_read_obj) },
    { MP_ROM_QSTR(MP_QSTR_readinto), MP_ROM_PTR(&mp_stream_readinto_obj) },
    { MP_ROM_QSTR(MP_QSTR_write), MP_ROM_PTR(&mp_stream_write_obj) },
    { MP_ROM_QSTR(MP_QSTR_ioctl), MP_ROM_PTR(&mp_stream_ioctl_obj) },
};
static MP_DEFINE_CONST_DICT(term_locals_dict, term_locals_table);

static MP_DEFINE_CONST_OBJ_TYPE(
    okou_term_type, MP_QSTR_Term, MP_TYPE_FLAG_ITER_IS_STREAM,
    protocol, &term_stream_p,
    locals_dict, &term_locals_dict);

static const term_obj_t s_term = {{&okou_term_type}};

/* ------------------------------------------------------------------ py.exec */

typedef struct {
    okou_req_t *req;
    bool eval;
    char code[];
} exec_job_t;

static exec_job_t *volatile s_job; /* at most one in flight */

static void cap_strn(void *env, const char *str, size_t len)
{
    term_out(str, len); /* exceptions also show up in the log stream */
}
static const mp_print_t s_cap_print = {NULL, cap_strn};

typedef struct {
    char *buf;
    size_t len, cap;
} sbuf_t;
static void sbuf_strn(void *env, const char *str, size_t len)
{
    sbuf_t *b = env;
    size_t k = len < b->cap - 1 - b->len ? len : b->cap - 1 - b->len;
    memcpy(b->buf + b->len, str, k);
    b->len += k;
}

static void job_finish(exec_job_t *j, bool ok, cJSON *data, const char *err)
{
    if (s_job == j) {
        s_job = NULL;
    }
    okou_op_reply(j->req, ok, data, err);
    free(j);
}

static mp_obj_t exec_cb(mp_obj_t arg)
{
    exec_job_t *j = MP_OBJ_TO_PTR(arg);
    char result[RESULT_CAP] = "";
    sbuf_t rb = {result, 0, sizeof(result)};
    mp_print_t rprint = {&rb, sbuf_strn};
    bool failed = false;
    size_t exc_at = 0;

    line_flush();
    s_cap_len = 0;
    s_cap_trunc = false;
    s_capturing = true;
    int prev_ichar = mp_interrupt_char;
    mp_hal_set_interrupt_char(CHAR_CTRL_C); /* py.interrupt works even when started from the REPL */
    nlr_buf_t nlr;
    if (nlr_push(&nlr) == 0) {
        mp_obj_t code = mp_obj_new_str(j->code, strlen(j->code));
        mp_obj_t globals = MP_OBJ_FROM_PTR(&MP_STATE_VM(dict_main));
        if (j->eval) {
            mp_obj_t args[2] = {code, globals};
            mp_obj_t r = mp_call_function_n_kw(MP_OBJ_FROM_PTR(&mp_builtin_eval_obj), 2, 0, args);
            mp_obj_print_helper(&rprint, r, PRINT_REPR);
        } else {
            mp_obj_t args[2] = {code, globals};
            mp_call_function_n_kw(MP_OBJ_FROM_PTR(&mp_builtin_exec_obj), 2, 0, args);
        }
        nlr_pop();
    } else {
        failed = true;
        exc_at = s_cap_len;
        mp_obj_print_exception(&s_cap_print, MP_OBJ_FROM_PTR(nlr.ret_val));
    }
    mp_hal_set_interrupt_char(prev_ichar);
    line_flush();
    s_capturing = false;

    cJSON *d = cJSON_CreateObject();
    size_t out_len = failed ? exc_at : s_cap_len;
    s_cap[s_cap_len] = '\0';
    char saved = s_cap[out_len];
    s_cap[out_len] = '\0';
    cJSON_AddStringToObject(d, "output", s_cap);
    s_cap[out_len] = saved;
    if (j->eval && !failed) {
        cJSON_AddStringToObject(d, "result", result);
    }
    if (failed) {
        cJSON_AddStringToObject(d, "exception", s_cap + exc_at);
    } else {
        cJSON_AddNullToObject(d, "exception");
    }
    if (s_cap_trunc) {
        cJSON_AddBoolToObject(d, "truncated", true);
    }
    job_finish(j, true, d, NULL);
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(exec_cb_obj, exec_cb);

static esp_err_t op_py_exec(okou_req_t *req, const cJSON *args, char *err, size_t errlen)
{
    const cJSON *code = cJSON_GetObjectItemCaseSensitive(args, "code");
    if (!cJSON_IsString(code)) {
        snprintf(err, errlen, "code (string) required");
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_cap) {
        snprintf(err, errlen, "no capture buffer");
        return ESP_ERR_NO_MEM;
    }
    if (s_job) {
        snprintf(err, errlen, "busy: another py.exec is running");
        return ESP_ERR_INVALID_STATE;
    }
    size_t n = strlen(code->valuestring);
    exec_job_t *j = malloc(sizeof(*j) + n + 1);
    if (!j) {
        snprintf(err, errlen, "out of memory");
        return ESP_ERR_NO_MEM;
    }
    j->req = req;
    j->eval = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(args, "eval"));
    memcpy(j->code, code->valuestring, n + 1);
    s_job = j;
    if (!mp_sched_schedule(MP_OBJ_FROM_PTR(&exec_cb_obj), MP_OBJ_FROM_PTR(j))) {
        s_job = NULL;
        free(j);
        snprintf(err, errlen, "interpreter scheduler queue full");
        return ESP_ERR_NO_MEM;
    }
    mp_hal_wake_main_task();
    return ESP_OK;
}

/* ------------------------------------------------------------------ other ops */

static void interrupt_running(void)
{
    if (mp_interrupt_char == CHAR_CTRL_C) { /* code is running (not waiting at the REPL) */
        mp_sched_keyboard_interrupt();
    }
    mp_hal_wake_main_task();
}

static portMUX_TYPE s_in_mux = portMUX_INITIALIZER_UNLOCKED;

static void in_push(const uint8_t *p, size_t n)
{
    portENTER_CRITICAL(&s_in_mux);
    for (size_t i = 0; i < n; i++) {
        if (ringbuf_put(&stdin_ringbuf, p[i]) < 0) {
            break; /* full: drop */
        }
    }
    portEXIT_CRITICAL(&s_in_mux);
}

static esp_err_t op_py_interrupt(const cJSON *args, cJSON *data, char *err, size_t errlen)
{
    cJSON_AddBoolToObject(data, "running", mp_interrupt_char == CHAR_CTRL_C);
    interrupt_running();
    return ESP_OK;
}

static esp_err_t op_py_reset(const cJSON *args, cJSON *data, char *err, size_t errlen)
{
    const uint8_t eot = 0x04; /* Ctrl-D at the friendly REPL = soft reset */
    in_push(&eot, 1);
    interrupt_running();
    return ESP_OK;
}

static esp_err_t op_py_safe_boot(const cJSON *args, cJSON *data, char *err, size_t errlen)
{
    okou_nvs_set_u8("pysafe", 1);
    okou_schedule_reboot(300);
    return ESP_OK;
}

static esp_err_t op_term_write(const cJSON *args, cJSON *data, char *err, size_t errlen)
{
    const cJSON *d = cJSON_GetObjectItemCaseSensitive(args, "data");
    if (!cJSON_IsString(d)) {
        snprintf(err, errlen, "data (string) required");
        return ESP_ERR_INVALID_ARG;
    }
    const uint8_t *p = (const uint8_t *)d->valuestring;
    size_t n = strlen(d->valuestring);
    for (size_t i = 0; i < n; i++) {
        if (p[i] == CHAR_CTRL_C && mp_interrupt_char == CHAR_CTRL_C) {
            mp_sched_keyboard_interrupt();
        } else {
            in_push(&p[i], 1);
        }
    }
    mp_hal_wake_main_task();
    return ESP_OK;
}

/* ------------------------------------------------------------------ start hook */

static void sntp_task(void *arg)
{
    /* MicroPython enables certificate date checks: TLS (hub, requests) needs the clock. */
    while (!okou_net_has_ip()) {
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    esp_sntp_config_t c = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_err_t e = esp_netif_sntp_init(&c);
    if (e != ESP_OK) {
        ESP_LOGW(TAG, "SNTP start failed: %s", esp_err_to_name(e));
    }
    vTaskDelete(NULL);
}

void okl_runtime_start(void)
{
    s_cap = heap_caps_malloc(OUT_CAP, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_cap) {
        s_cap = malloc(OUT_CAP);
    }
    okou_op_register_async("py.exec", op_py_exec);
    okou_op_register("py.interrupt", op_py_interrupt);
    okou_op_register("py.reset", op_py_reset);
    okou_op_register("py.safe_boot", op_py_safe_boot);
    okou_op_register("term.write", op_term_write);
    okou_config_t cfg = OKOU_CONFIG_DEFAULT(); /* role app, SDK-managed Wi-Fi */
    esp_err_t e = okou_agent_start(&cfg);
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "okou_agent_start: %s", esp_err_to_name(e));
    }
    xTaskCreate(sntp_task, "okl_sntp", 3072, NULL, 3, NULL);
}

/* ------------------------------------------------------------------ Python module */

static mp_obj_t okou_term(void)
{
    /* Called from _boot.py on every (soft) boot: a py.exec scheduled before the interpreter
     * restarted will never run, so answer it now. */
    exec_job_t *j = s_job;
    if (j) {
        s_capturing = false;
        job_finish(j, false, NULL, "interpreter restarted");
    }
    return MP_OBJ_FROM_PTR(&s_term);
}
static MP_DEFINE_CONST_FUN_OBJ_0(okou_term_obj, okou_term);

static mp_obj_t okou_connected_py(void)
{
    return mp_obj_new_bool(okou_connected());
}
static MP_DEFINE_CONST_FUN_OBJ_0(okou_connected_obj, okou_connected_py);

static mp_obj_t okou_event_py(size_t n_args, const mp_obj_t *args)
{
    okou_event(mp_obj_str_get_str(args[0]), n_args > 1 && args[1] != mp_const_none ? mp_obj_str_get_str(args[1]) : NULL);
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(okou_event_obj, 1, 2, okou_event_py);

static mp_obj_t okou_metric_py(mp_obj_t name, mp_obj_t value)
{
    okou_metric(mp_obj_str_get_str(name), mp_obj_get_float(value));
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_2(okou_metric_obj, okou_metric_py);

static mp_obj_t okou_safe_boot_py(void)
{
    bool safe = okou_nvs_get_u8("pysafe", 0) != 0;
    if (safe) {
        okou_nvs_set_u8("pysafe", 0);
    }
    return mp_obj_new_bool(safe);
}
static MP_DEFINE_CONST_FUN_OBJ_0(okou_safe_boot_obj, okou_safe_boot_py);

static const mp_rom_map_elem_t okou_module_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR___name__), MP_ROM_QSTR(MP_QSTR_okou) },
    { MP_ROM_QSTR(MP_QSTR_term), MP_ROM_PTR(&okou_term_obj) },
    { MP_ROM_QSTR(MP_QSTR_connected), MP_ROM_PTR(&okou_connected_obj) },
    { MP_ROM_QSTR(MP_QSTR_event), MP_ROM_PTR(&okou_event_obj) },
    { MP_ROM_QSTR(MP_QSTR_metric), MP_ROM_PTR(&okou_metric_obj) },
    { MP_ROM_QSTR(MP_QSTR_safe_boot), MP_ROM_PTR(&okou_safe_boot_obj) },
};
static MP_DEFINE_CONST_DICT(okou_module_globals, okou_module_globals_table);

const mp_obj_module_t okou_module = {
    .base = {&mp_type_module},
    .globals = (mp_obj_dict_t *)&okou_module_globals,
};
MP_REGISTER_MODULE(MP_QSTR_okou, okou_module);
