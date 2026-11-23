idf_component_register(SRCS "main.c" "../../../components/okou_agent/src/okou_install.c" "coredump_ops.c" "prov_common.c" "prov_serial.c"
    INCLUDE_DIRS "."
    REQUIRES okou_agent app_update esp_http_client esp_partition mbedtls espcoredump nvs_flash json
             esp_driver_uart esp_driver_usb_serial_jtag vfs esp_timer esp_app_format bootloader_support)
