cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components")
# CI passes -DPROJECT_VER=<major.minor>.<run number>; local builds are "<major.minor>.0-dev".
if(NOT DEFINED PROJECT_VER)
    file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/../version.txt" _okl_base LIMIT_COUNT 1)
    set(PROJECT_VER "${_okl_base}.0-dev")
endif()
if("${ESPHUB_BOARD}" STREQUAL "")
    message(FATAL_ERROR "Select a launcher board with -DESPHUB_BOARD=<board> (see firmware/boards).")
endif()
if(NOT ESPHUB_BOARD MATCHES "^[a-z0-9]+(-[a-z0-9]+)*$" OR
   NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/../boards/${ESPHUB_BOARD}/launcher/sdkconfig.defaults")
    message(FATAL_ERROR "Unknown launcher board '${ESPHUB_BOARD}'. See firmware/boards.")
endif()
if(NOT DEFINED SDKCONFIG_DEFAULTS)
    set(SDKCONFIG_DEFAULTS "../sdkconfig.common;sdkconfig.defaults;../boards/${ESPHUB_BOARD}/launcher/sdkconfig.defaults;../ble.defaults")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(esp-launcher)

# Let the SDK omit app-only command and boot paths from the launcher image.
idf_component_get_property(agent_library okou_agent COMPONENT_LIB)
target_compile_definitions(${agent_library} PRIVATE OKOU_LAUNCHER_BUILD)
