#!/usr/bin/env python3
"""Integrate the EspHub Runtime with the pinned upstream ESP32-S31 port."""
import json
from pathlib import Path
import shutil
import sys

upstream, firmware = (Path(path).resolve() for path in sys.argv[1:3])
board, version, board_dir = sys.argv[3:6]
profile = json.loads((Path(board_dir) / "board.json").read_text())
assert profile["chip"] == "esp32s31"
port = upstream / "ports" / "esp32"
overlay = firmware / "pyrt" / "overlay"


def replace(path, old, new):
    source = path.read_text()
    assert source.count(old) == 1, f"Unexpected upstream source: {path}: {old}"
    path.write_text(source.replace(old, new, 1))


agent = port / "components" / "okou_agent"
shutil.copytree(firmware / "components" / "okou_agent", agent, dirs_exist_ok=True)
runtime = port / "esphub"
shutil.copytree(overlay / "cmodules" / "okou", runtime / "okou")
shutil.copy(overlay / "okl" / "_boot.py", runtime)
(runtime / "manifest.py").write_text(
    'module("_boot.py")\ninclude("$(MPY_DIR)/extmod/asyncio")\n'
)
shutil.copy(overlay / "partitions_okl_build.csv", port)
target = port / "boards" / "ESPHUB_MOSAICO"
shutil.copytree(port / "boards" / "ESP32_GENERIC_S31", target)
replace(target / "mpconfigboard.h", "Generic ESP32S31 module", "Espressif ESP-Mosaico")
replace(target / "mpconfigboard.h", "#define MICROPY_HW_ENABLE_USBDEV              (1)",
        "#define MICROPY_HW_ENABLE_USBDEV              (0)")
with (target / "mpconfigboard.cmake").open("a") as config:
    config.write(
        "\nlist(APPEND SDKCONFIG_DEFAULTS boards/ESPHUB_MOSAICO/sdkconfig.esphub)\n"
        "set(MICROPY_FROZEN_MANIFEST ${CMAKE_CURRENT_LIST_DIR}/../../esphub/manifest.py)\n"
        "set(USER_C_MODULES ${CMAKE_CURRENT_LIST_DIR}/../../esphub/okou/micropython.cmake)\n"
    )
(target / "sdkconfig.esphub").write_text(
    (overlay / "sdkconfig.okl").read_text()
    + (firmware / "ble.defaults").read_text()
    + f'CONFIG_APP_PROJECT_VER="{version}"\n'
    + f'CONFIG_OKOU_BOARD_PROFILE="{board}"\n'
    + f'CONFIG_OKOU_BL_PROFILE="{profile["bootloader"]}"\n'
    + "CONFIG_SPIRAM=y\nCONFIG_SPIRAM_SPEED_250M=y\n"
    + "CONFIG_ESP_CONSOLE_UART_DEFAULT=y\nCONFIG_ESP_CONSOLE_SECONDARY_NONE=y\n"
    + "CONFIG_MBEDTLS_X509_CREATE_C=y\nCONFIG_MBEDTLS_X509_CSR_WRITE_C=y\n"
)
replace(port / "esp32_common.cmake", "list(APPEND IDF_COMPONENTS\n    app_update",
        "list(APPEND IDF_COMPONENTS\n    okou_agent\n    app_update")
main = port / "main.c"
replace(main, '#include "py/runtime.h"', '#include "py/runtime.h"\n#include "okou_agent.h"')
replace(main, "void MICROPY_ESP_IDF_ENTRY(void) {",
        "void okl_runtime_start(void);\n\nvoid MICROPY_ESP_IDF_ENTRY(void) {")
# The EspHub SDK initializes the installed NVS without erasing it on error.
# Its partition table already defines the filesystem, so skip the generic board hook.
replace(main, "    MICROPY_BOARD_STARTUP();", "    okl_runtime_start();")
replace(main, '    if (err != ESP_OK) {\n        ESP_LOGE("esp_init", "can\'t create event loop',
        '    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {\n        ESP_LOGE("esp_init", "can\'t create event loop')
replace(main, "    if (pyexec_mode_kind == PYEXEC_MODE_FRIENDLY_REPL && ret != 0) {",
        '    mp_obj_t run_main = mp_load_global(MP_QSTR__uiflow_run_main);\n'
        '    if (mp_obj_is_true(run_main) && ret != 0) {')
replace(main, '        int ret = pyexec_file_if_exists("main.py");',
        '        int ret = pyexec_file_if_exists("main.py");\n'
        '        if (ret == PYEXEC_UNHANDLED_EXCEPTION) okou_event("program.failed", "main.py");')
source = main.read_text()
start = source.index("    for (;;) {\n        if (pyexec_mode_kind == PYEXEC_MODE_RAW_REPL)")
end = source.index("\nsoft_reset_exit:", start)
main.write_text(source[:start] + """    for (;;) {
        mp_handle_pending(false);
        MP_THREAD_GIL_EXIT();
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
        MP_THREAD_GIL_ENTER();
    }
""" + source[end:])
replace(upstream / "extmod" / "nimble" / "modbluetooth_nimble.c",
        "int mp_bluetooth_init(void) {",
        "extern bool okou_ble_host_owned(void);\nint mp_bluetooth_init(void) {\n"
        "    if (okou_ble_host_owned()) return MP_EBUSY;")
