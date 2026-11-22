set(srcs "main.c" "install.c" "coredump_ops.c" "prov_common.c" "prov_serial.c")
if(NOT CMAKE_BUILD_EARLY_EXPANSION)
    list(APPEND srcs "../../boards/${CONFIG_OKOU_BOARD_PROFILE}/launcher/board.c")
endif()
idf_component_register(SRCS ${srcs}
    INCLUDE_DIRS "."
    REQUIRES okou_agent app_update esp_http_client esp_partition mbedtls espcoredump nvs_flash json
             esp_driver_gpio esp_driver_i2c esp_driver_uart esp_driver_usb_serial_jtag vfs esp_timer esp_app_format bootloader_support)
