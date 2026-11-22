#pragma once
#include "cJSON.h"
#include <stdbool.h>

/* Called by the agent task. The MQTT task only sets event bits. */
bool okou_iot_available(void);
bool okou_iot_start(void);
void okou_iot_stop(void);
unsigned okou_iot_events(void);
enum { IOT_SUBSCRIBED=1, IOT_WAKE=2, IOT_OFFLINE=4 };
cJSON *okou_iot_post(const char *operation, cJSON *body);
