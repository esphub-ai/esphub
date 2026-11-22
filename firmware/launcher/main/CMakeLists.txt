if(NOT CMAKE_BUILD_EARLY_EXPANSION AND NOT "${CONFIG_OKOU_BOARD_PROFILE}" STREQUAL "${ESPHUB_BOARD}")
    message(FATAL_ERROR "sdkconfig selects '${CONFIG_OKOU_BOARD_PROFILE}', but ESPHUB_BOARD is '${ESPHUB_BOARD}'. Use a matching board sdkconfig.")
endif()
idf_component_register(SRCS "main.c" "install.c" "coredump_ops.c" "prov_common.c" "prov_serial.c"
    INCLUDE_DIRS "."
    REQUIRES okou_agent app_update esp_http_client esp_partition mbedtls espcoredump nvs_flash json
             esp_driver_uart esp_driver_usb_serial_jtag vfs esp_timer esp_app_format bootloader_support)
