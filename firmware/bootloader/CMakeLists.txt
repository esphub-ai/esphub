cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components")
# CI passes -DPROJECT_VER=<major.minor>.<run number>; local builds are "<major.minor>.0-dev".
if(NOT DEFINED PROJECT_VER)
    file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/../version.txt" _okl_base LIMIT_COUNT 1)
    set(PROJECT_VER "${_okl_base}.0-dev")
endif()
if(NOT ESPHUB_BL MATCHES "^([a-z0-9]+)-([0-9]+)mb$")
    message(FATAL_ERROR "Select a bootloader variant with -DESPHUB_BL=<target>-<size>mb.")
endif()
set(variant_target "${CMAKE_MATCH_1}")
set(variant_flash "${CMAKE_MATCH_2}MB")
if(NOT "${IDF_TARGET}" STREQUAL "${variant_target}" OR
   NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/variants/${ESPHUB_BL}/sdkconfig.defaults")
    message(FATAL_ERROR "Unknown bootloader variant '${ESPHUB_BL}' for '${IDF_TARGET}'.")
endif()
set(SDKCONFIG_DEFAULTS "../sdkconfig.common;sdkconfig.defaults;variants/${ESPHUB_BL}/sdkconfig.defaults;../ble.defaults")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(esp-launcher)

if(NOT "${CONFIG_OKOU_BL_PROFILE}" STREQUAL "${ESPHUB_BL}" OR
   NOT "${CONFIG_ESPTOOLPY_FLASHSIZE}" STREQUAL "${variant_flash}" OR
   NOT "${CONFIG_OKOU_BOARD_PROFILE}" STREQUAL "" OR CONFIG_SPIRAM)
    message(FATAL_ERROR "Use a clean sdkconfig for bootloader variant '${ESPHUB_BL}'.")
endif()

# Let the SDK omit app-only command and boot paths from the launcher image.
idf_component_get_property(agent_library okou_agent COMPONENT_LIB)
target_compile_definitions(${agent_library} PRIVATE OKOU_LAUNCHER_BUILD)
