#include "bsp/esp_mosaico.h"
#include "esp_err.h"
#include "esp_log.h"
#include "okou_agent.h"

void mosaico_hmi_main(void);

void app_main(void)
{
    const okou_config_t config = OKOU_CONFIG_DEFAULT();
    esp_err_t err = okou_agent_start(&config);
    if (err != ESP_OK) {
        ESP_LOGE("mosaico_hmi", "EspHub SDK startup failed: %s", esp_err_to_name(err));
    }
    // TE sync in the pinned adapter renders full frames. Partial rendering
    // keeps each flush within the BSP's eight-row SPI transfer limit.
    bsp_display_config_t display = BSP_DISPLAY_DEFAULT_CONFIG();
    display.tear_avoid_mode = ESP_LV_ADAPTER_TEAR_AVOID_MODE_NONE;
    display.buffer_height = 8;
    if (bsp_display_start_with_config(&display)) {
        // The upstream example reuses the BSP display initialized above.
        mosaico_hmi_main();
    }
}
