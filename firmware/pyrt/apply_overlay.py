#!/usr/bin/env python3
"""Turn a UIFlow2 MicroPython checkout (m5stack/uiflow-micropython) into the esp-launcher
Python runtime for one board. Every edit asserts its anchor, so an upstream change fails the
build instead of silently producing a different firmware.

  apply_overlay.py <uiflow checkout> <esp-launcher firmware dir> <board> <version>
"""
import pathlib
import shutil
import sys

uiflow, fw, board, version = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4]
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
     "    MICROPY_BOARD_STARTUP();\n    okl_runtime_start(); /* okou_agent owns Wi-Fi and the hub link */\n")

# 3. Board: our sdkconfig fragment last, our frozen manifest, no Japanese/Korean 24 px fonts.
bdir = f"boards/{board}"
if board == "M5STACK_StopWatch":
    # Match the Paper Color runtime's compact M5/Widgets display bindings.
    # UIFlow's separate LVGL Python bindings reference fonts omitted from this image.
    edit(f"{bdir}/mpconfigboard.cmake", "set(MICROPY_PY_LVGL 1)", "set(MICROPY_PY_LVGL 0)")
    edit(f"{bdir}/mpconfigboard.cmake", "set(ADF_MODULE_ENABLE TRUE)", "set(ADF_MODULE_ENABLE FALSE)")
frag = (ov / "sdkconfig.okl").read_text() + f'CONFIG_APP_PROJECT_VER="{version}"\n'
profile = {"M5STACK_PaperColor": "paper-color", "M5STACK_StopWatch": "stopwatch"}[board]
(m5 / bdir / "sdkconfig.okl").write_text(frag + f'CONFIG_OKOU_BOARD_PROFILE="{profile}"\n')
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
