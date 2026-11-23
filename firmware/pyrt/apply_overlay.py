#!/usr/bin/env python3
"""Turn a UIFlow2 MicroPython checkout (m5stack/uiflow-micropython) into the esp-launcher
Python runtime for one board. Every edit asserts its anchor, so an upstream change fails the
build instead of silently producing a different firmware.

  apply_overlay.py <uiflow checkout> <esp-launcher firmware dir> <board> <version> <board directory>
"""
import json
import re
import pathlib
import shutil
import sys

uiflow, fw, profile, version = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4]
board_dir = pathlib.Path(sys.argv[5])
config = json.loads((board_dir / "micropython/profile.json").read_text())
board = config["target"]
bootloader = json.loads((board_dir / "board.json").read_text())["bootloader"]
m5 = uiflow / "m5stack"
ov = fw / "pyrt" / "overlay"


def edit(path, old, new, count=1):
    p = m5 / path
    s = p.read_text()
    assert s.count(old) >= 1, f"{path}: anchor not found: {old!r}"
    p.write_text(s.replace(old, new, count))
    print(f"edited {path}")


# 1. okou_agent SDK component, the `okou` C module, our boot + frozen manifest, build table.
shutil.copytree(fw / "components" / "okou_agent", m5 / "components" / "okou_agent", dirs_exist_ok=True)
shutil.copytree(ov / "cmodules" / "okou", m5 / "cmodules" / "okou", dirs_exist_ok=True)
shutil.copytree(ov / "okl", m5 / "okl", dirs_exist_ok=True)
shutil.copy(ov / "partitions_okl_build.csv", m5 / "partitions_okl_build.csv")
(m5 / "cmodules" / "cmodules.cmake").open("a").write(
    "\n# esp-launcher Python runtime\ninclude(${CMAKE_CURRENT_LIST_DIR}/okou/micropython.cmake)\n")
print("edited cmodules/cmodules.cmake")
edit("CMakeListsDefault.cmake", "    esp_driver_ppa\n)", "    esp_driver_ppa\n    okou_agent\n)")

# 2. Start the agent (Wi-Fi, hub) from C before the MicroPython task exists.
edit("main.c", "void MICROPY_ESP_IDF_ENTRY(void) {",
     "void okl_runtime_start(void); /* esp-launcher: cmodules/okou/modokou.c */\n\nvoid MICROPY_ESP_IDF_ENTRY(void) {")
edit("main.c", "    MICROPY_BOARD_STARTUP();\n",
     "    MICROPY_BOARD_STARTUP();\n    okl_runtime_start();\n")

# pyexec prints the exception and traceback through dupterm. Report its outcome
# to the Hub immediately even if the periodic log batch is still pending.
edit("main.c", '#include "py/runtime.h"', '#include "py/runtime.h"\n#include "okou_agent.h"')
for script, indent in (("boot.py", "    "), ("main.py", "        ")):
    call = f'int ret = pyexec_file_if_exists("{script}");'
    edit("main.c", call, call + f'\n{indent}if (ret == PYEXEC_UNHANDLED_EXCEPTION) okou_event("program.failed", "{script}");')

# Keep raw and friendly REPL upload modes out of the production USB console.
edit("main.c", """    for (;;) {
        if (pyexec_mode_kind == PYEXEC_MODE_RAW_REPL) {
            vprintf_like_t vprintf_log = esp_log_set_vprintf(vprintf_null);
            if (pyexec_raw_repl() != 0) {
                break;
            }
            esp_log_set_vprintf(vprintf_log);
        } else {
            if (pyexec_friendly_repl() != 0) {
                break;
            }
        }
    }
""", """    /* Applications can read USB input. Finished programs idle with VM callbacks
     * enabled while the native agent remains available for OTA and recovery. */
    for (;;) {
        mp_handle_pending(false);
        MP_THREAD_GIL_EXIT();
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
        MP_THREAD_GIL_ENTER();
    }
""")

# Keep the native USB-OTG link awake while it enumerates or carries traffic.
# TinyUSB dispatches bus events on the VM task, so this needs no USB polling.
for source in ("mp_usbd.c", "mp_usbd_runtime.c"):
    edit("../micropython/shared/tinyusb/" + source, "    tud_task_ext(0, false);",
         "    tud_task_ext(0, false);\n"
         "    extern void okl_usb_bus_active(bool active);\n"
         "    okl_usb_bus_active(tud_connected() && !tud_suspended());")

# 3. Board: our sdkconfig fragment last, our frozen manifest, no Japanese/Korean 24 px fonts.
bdir = f"boards/{board}"
extra_manifest = board_dir / "micropython/manifest.py"
if extra_manifest.exists():
    with (m5 / "okl/manifest.py").open("a") as manifest:
        manifest.write("\n" + extra_manifest.read_text())
for option in config.get("disable_cmake_options", []):
    path = m5 / bdir / "mpconfigboard.cmake"
    text, count = re.subn(rf"set\({re.escape(option)} (?:1|TRUE)\)", f"set({option} 0)", path.read_text())
    assert count == 1, f"{path}: expected enabled {option}"
    path.write_text(text)
frag = (ov / "sdkconfig.okl").read_text() + f'CONFIG_APP_PROJECT_VER="{version}"\n'
frag += (fw / "ble.defaults").read_text()
# The provisioning service owns NimBLE during boot discovery and provisioning.
edit("../micropython/extmod/nimble/modbluetooth_nimble.c", "int mp_bluetooth_init(void) {",
     "extern bool okou_ble_host_owned(void);\nint mp_bluetooth_init(void) {\n"
     "    if (okou_ble_host_owned()) return MP_EBUSY;")

(m5 / bdir / "sdkconfig.okl").write_text(frag + f'CONFIG_OKOU_BOARD_PROFILE="{profile}"\nCONFIG_OKOU_BL_PROFILE="{bootloader}"\n')
edit(f"{bdir}/mpconfigboard.cmake", f"    {bdir}/sdkconfig.board\n)",
     f"    {bdir}/sdkconfig.board\n    {bdir}/sdkconfig.okl\n)")
edit(f"{bdir}/mpconfigboard.cmake", "set(FONT_ALIBABASANS_JA24 1)", "set(FONT_ALIBABASANS_JA24 0)")
edit(f"{bdir}/mpconfigboard.cmake", "set(FONT_ALIBABASANS_KR24 1)", "set(FONT_ALIBABASANS_KR24 0)")
edit(f"{bdir}/mpconfigboard.cmake", "if(NOT MICROPY_FROZEN_MANIFEST)",
     "set(MICROPY_FROZEN_MANIFEST ${CMAKE_SOURCE_DIR}/okl/manifest.py)\nif(NOT MICROPY_FROZEN_MANIFEST)")

# 4. Font flags only hid the fonts from Python; also drop their data and objects.
edit("components/M5Unified/CMakeLists.txt",
     "    USR_FONT_ALIBABASANS_KR24=${FONT_ALIBABASANS_KR24}\n)",
     "    USR_FONT_ALIBABASANS_KR24=${FONT_ALIBABASANS_KR24}\n"
     "    ALIBABASANS_JP24=${FONT_ALIBABASANS_JA24}\n"
     "    ALIBABASANS_KR24=${FONT_ALIBABASANS_KR24}\n)")
edit("components/M5Unified/mpy_m5gfx.cpp",
     "// FONT_ALIBABASANS_JA24\nextern const lv_font_t AlibabaSans_JP24;\n"
     "const M5LvglFont AlibabaSans_JP24_obj(&AlibabaSans_JP24);\n"
     "const font_obj_t gfx_font_AlibabaSans_JP24_obj = {{ &mp_type_object }, &AlibabaSans_JP24_obj };\n",
     "#if USR_FONT_ALIBABASANS_JA24\n// FONT_ALIBABASANS_JA24\nextern const lv_font_t AlibabaSans_JP24;\n"
     "const M5LvglFont AlibabaSans_JP24_obj(&AlibabaSans_JP24);\n"
     "const font_obj_t gfx_font_AlibabaSans_JP24_obj = {{ &mp_type_object }, &AlibabaSans_JP24_obj };\n#endif\n")
edit("components/M5Unified/mpy_m5gfx.cpp",
     "// FONT_ALIBABASANS_KR24\nextern const lv_font_t AlibabaSans_KR24;\n"
     "const M5LvglFont AlibabaSans_KR24_obj(&AlibabaSans_KR24);\n"
     "const font_obj_t gfx_font_AlibabaSans_KR24_obj = {{ &mp_type_object }, &AlibabaSans_KR24_obj };\n",
     "#if USR_FONT_ALIBABASANS_KR24\n// FONT_ALIBABASANS_KR24\nextern const lv_font_t AlibabaSans_KR24;\n"
     "const M5LvglFont AlibabaSans_KR24_obj(&AlibabaSans_KR24);\n"
     "const font_obj_t gfx_font_AlibabaSans_KR24_obj = {{ &mp_type_object }, &AlibabaSans_KR24_obj };\n#endif\n")
print("overlay applied for", board, version)
