/* ESP Hub MicroPython runtime, application input and log output. SPDX-License-Identifier: MIT */
#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_pm.h"
#include "esp_crt_bundle.h"
#include "esp_timer.h"
#include "freertos/message_buffer.h"

#include "cJSON.h"

#include "py/runtime.h"
#include "py/mperrno.h"
#include "py/stream.h"
#include "py/mphal.h"
#include "py/builtin.h"

#include "shared/runtime/interrupt_char.h"
#include "shared/readline/readline.h" /* CHAR_CTRL_C */

#include "okou_agent.h"
#include "okou_agent_ext.h"
#include "okou_install.h"

static const char *TAG = "okl_py";

void mp_hal_wake_main_task(void);

#define LINE_CAP    240

/* ------------------------------------------------------------------ terminal (dupterm) */

static char s_line[LINE_CAP];
static size_t s_line_len;

static void line_flush(void)
{
    if (s_line_len) {
        okou_log_text('O', s_line, s_line_len);
        s_line_len = 0;
    }
}

static void term_out(const char *buf, size_t n)
{
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

static void interrupt_running(void)
{
    if (mp_interrupt_char == CHAR_CTRL_C) { /* code is running (not waiting at the REPL) */
        mp_sched_keyboard_interrupt();
    }
    mp_hal_wake_main_task();
}

static esp_err_t op_py_interrupt(const cJSON *args, cJSON *data, char *err, size_t errlen)
{
    cJSON_AddBoolToObject(data, "running", mp_interrupt_char == CHAR_CTRL_C);
    interrupt_running();
    return ESP_OK;
}

static esp_err_t op_py_safe_boot(const cJSON *args, cJSON *data, char *err, size_t errlen)
{
    okou_nvs_set_u8("pysafe", 1);
    okou_schedule_reboot(300);
    return ESP_OK;
}

/* Application messages are never fed into MicroPython's REPL. */
static MessageBufferHandle_t s_input;
static esp_err_t op_term_write(const cJSON *args, cJSON *data, char *err, size_t errlen)
{
    const cJSON *d = cJSON_GetObjectItemCaseSensitive(args, "data");
    if (!cJSON_IsString(d)) {
        snprintf(err, errlen, "data (string) required");
        return ESP_ERR_INVALID_ARG;
    }
    size_t len = strlen(d->valuestring);
    if (!s_input || !len || len > 1024 || xMessageBufferSend(s_input, d->valuestring, len, 0) != len) {
        snprintf(err, errlen, "application input queue full or invalid");
        return ESP_ERR_INVALID_STATE;
    }
    return ESP_OK;
}

static mp_obj_t okou_read_input(void)
{
    char message[1024];
    size_t n = s_input ? xMessageBufferReceive(s_input, message, sizeof(message), 0) : 0;
    return n ? mp_obj_new_str(message, n) : mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_0(okou_read_input_obj, okou_read_input);

/* Captured by the VM after staging/validation, delivered by the network task.
 * Keep source out of hello, console logs, and the VM's garbage-collected heap. */
typedef struct {
    const char *status;
    size_t len;
    char bytes[];
} program_snapshot_t;

static portMUX_TYPE program_lock = portMUX_INITIALIZER_UNLOCKED;
static program_snapshot_t *pending_program;

static mp_obj_t okou_report_program(mp_obj_t state, mp_obj_t contents)
{
    const char *status = mp_obj_str_get_str(state);
    const char *const states[] = {"available", "missing", "too_large", "unreadable"};
    for (size_t i = 0; i < sizeof(states) / sizeof(*states); i++) {
        if (strcmp(status, states[i])) continue;
        mp_buffer_info_t buf;
        mp_get_buffer_raise(contents, &buf, MP_BUFFER_READ);
        if (buf.len > 32768 || (i && buf.len)) mp_raise_ValueError(MP_ERROR_TEXT("invalid source length"));
        program_snapshot_t *next = malloc(sizeof(*next) + buf.len);
        if (!next) mp_raise_OSError(MP_ENOMEM);
        next->status = states[i];
        next->len = buf.len;
        if (buf.len) memcpy(next->bytes, buf.buf, buf.len);
        portENTER_CRITICAL(&program_lock);
        program_snapshot_t *old = pending_program;
        pending_program = next;
        portEXIT_CRITICAL(&program_lock);
        free(old);
        return mp_const_none;
    }
    mp_raise_ValueError(MP_ERROR_TEXT("invalid source status"));
}
static MP_DEFINE_CONST_FUN_OBJ_2(okou_report_program_obj, okou_report_program);

static void send_program(const char *boot_id)
{
    static int64_t retry_at;
    if (esp_timer_get_time() < retry_at) return;
    portENTER_CRITICAL(&program_lock);
    program_snapshot_t *snapshot = pending_program;
    pending_program = NULL;
    portEXIT_CRITICAL(&program_lock);
    if (!snapshot) return;

    char base[160], url[240];
    bool saved = false;
    if (okou_hub_http_base(base, sizeof(base)) == ESP_OK) {
        snprintf(url, sizeof(url), "%s/api/device/program/%s", base, boot_id);
        esp_http_client_config_t cfg = {.url=url, .method=HTTP_METHOD_PUT, .timeout_ms=5000,
            .crt_bundle_attach=esp_crt_bundle_attach, .disable_auto_redirect=true};
        esp_http_client_handle_t client = esp_http_client_init(&cfg);
        if (client) {
            okou_http_apply_auth(client);
            esp_http_client_set_header(client, "Content-Type", "application/octet-stream");
            esp_http_client_set_header(client, "X-Program-Status", snapshot->status);
            esp_http_client_set_post_field(client, snapshot->bytes, snapshot->len);
            saved = esp_http_client_perform(client) == ESP_OK && esp_http_client_get_status_code(client) == 200;
            esp_http_client_cleanup(client);
        }
    }
    if (!saved) {
        retry_at = esp_timer_get_time() + 60000000;
        portENTER_CRITICAL(&program_lock);
        if (!pending_program) {
            pending_program = snapshot;
            snapshot = NULL;
        }
        portEXIT_CRITICAL(&program_lock);
    }
    free(snapshot);
}

/* ------------------------------------------------------------------ start hook */

// Called by the TinyUSB task for native USB-OTG boards. USB-Serial/JTAG
// has its own cable-aware IDF power lock.
void okl_usb_bus_active(bool active)
{
    static esp_pm_lock_handle_t usb_lock;
    static bool held;
    if (active == held) return;
    if (!usb_lock && esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "usb-otg", &usb_lock) != ESP_OK)
        return;
    esp_err_t result = active ? esp_pm_lock_acquire(usb_lock) : esp_pm_lock_release(usb_lock);
    if (result == ESP_OK) held = active;
}

void okl_runtime_start(void)
{
    ESP_ERROR_CHECK(okou_nvs_init());
    okou_op_register("py.interrupt", op_py_interrupt);
    s_input = xMessageBufferCreate(4096);
    okou_op_register("py.safe_boot", op_py_safe_boot);
    okou_op_register("term.write", op_term_write);
    okou_config_t cfg = OKOU_CONFIG_DEFAULT(); /* role app, SDK-managed Wi-Fi */
    cfg.micropython_version = MICROPY_VERSION_STRING;
    okou_hooks_t hooks = {.on_connected_poll = send_program};
    okou_set_hooks(&hooks);
    esp_err_t e = okou_agent_start(&cfg);
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "okou_agent_start: %s", esp_err_to_name(e));
    }
}

/* ------------------------------------------------------------------ Python module */

static mp_obj_t okou_term(void)
{
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

static mp_obj_t okou_wifi_rssi_py(void)
{
    int rssi;
    return okou_wifi_rssi(&rssi) ? mp_obj_new_int(rssi) : mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_0(okou_wifi_rssi_obj, okou_wifi_rssi_py);

static const mp_rom_map_elem_t okou_module_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR_report_program), MP_ROM_PTR(&okou_report_program_obj) },
    { MP_ROM_QSTR(MP_QSTR_read_input), MP_ROM_PTR(&okou_read_input_obj) },
    { MP_ROM_QSTR(MP_QSTR_wifi_rssi), MP_ROM_PTR(&okou_wifi_rssi_obj) },
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
