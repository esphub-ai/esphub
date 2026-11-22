set(srcs "main.c" "install.c" "coredump_ops.c" "prov_common.c" "prov_serial.c" "board.c")
set(key_file "")
if(NOT CMAKE_BUILD_EARLY_EXPANSION)
    if(CONFIG_OKL_KEY_DEV)
        set(key_src "${CMAKE_CURRENT_LIST_DIR}/../../keys/dev_pub.pem")
    elseif(CONFIG_OKL_KEY_CUSTOM)
        get_filename_component(key_src "${CONFIG_OKL_KEY_CUSTOM_PATH}" ABSOLUTE BASE_DIR "${project_dir}")
    else()
        set(key_src "${CMAKE_CURRENT_LIST_DIR}/../../keys/release_pub.pem")
    endif()
    if(NOT EXISTS "${key_src}")
        message(FATAL_ERROR "signing public key not found: ${key_src}")
    endif()
    message(STATUS "esp-launcher: embedding signing public key ${key_src}")
    # Copy under a fixed name so the embedded symbol is always _binary_signing_pub_pem_start.
    configure_file("${key_src}" "${CMAKE_CURRENT_BINARY_DIR}/signing_pub.pem" COPYONLY)
    set(key_file "${CMAKE_CURRENT_BINARY_DIR}/signing_pub.pem")
endif()
idf_component_register(SRCS ${srcs}
    INCLUDE_DIRS "."
    REQUIRES okou_agent app_update esp_http_client esp_partition mbedtls espcoredump nvs_flash json
             esp_driver_gpio esp_driver_i2c esp_driver_uart esp_driver_usb_serial_jtag vfs esp_timer esp_app_format bootloader_support
    EMBED_TXTFILES ${key_file})
