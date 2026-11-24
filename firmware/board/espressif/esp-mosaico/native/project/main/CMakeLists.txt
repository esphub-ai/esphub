idf_component_register(SRCS "main.c"
    PRIV_REQUIRES app_display app_hello esp-gsp log okou_agent)
gsp_add_bundle(${COMPONENT_LIB}
    SCENES "${MOSAICO_HELLO}/components/app_hello/ui/main.json"
    PIXEL_FORMAT rgb565)
