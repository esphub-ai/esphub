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
    mosaico_hmi_main();
}
