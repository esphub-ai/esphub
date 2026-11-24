set(upstream_main "$ENV{MOSAICO_BSP}/examples/hmi_demo/main/main.c")
idf_component_register(SRCS "main.c" "${upstream_main}" REQUIRES okou_agent)
set_source_files_properties("${upstream_main}" PROPERTIES COMPILE_DEFINITIONS "app_main=mosaico_hmi_main")
