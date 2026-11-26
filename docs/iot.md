# Physical device protocol

In the MQTT hello, the EspHub Bootloader reports role `bootloader` and applications report role `app`. Every physical device hello identifies the boot and reports its Bluetooth and network-interface MACs and the launcher version when available. An app also reports its ESP-IDF application name and version in `fw`, and the SDK version in `sdk_version`. Extra diagnostics are returned by the on-demand status operation.

The bootloader and applications share one device agent. Firmware keeps a single authenticated MQTT session with AWS IoT Core in us-west-2. A device needs its registration token and P-256 key to enroll. USB installs the initial registration token and BLE bootstrap key. The SDK stores a plain ASCII hostname in `eh/hub` (up to 99 bytes). It builds HTTPS request URLs internally. The virtual ESP32 has no device credentials or network transport.

| Operation | Device path | Evidence of completion |
| --- | --- | --- |
| Connect to a Wi-Fi network on site | `EH-WIFI` over USB or a BLE session using an MCP-issued credential | The board reports the join result on the same connection |
| Save a network remotely | Cloud `wifi.add` via MQTT | Receipt after the NVS write. The queue erases the password on completion or timeout |
| Obtain MQTT credentials | HTTPS `POST /api/device/iot/enroll` with `{csr}` | NVS stores the certificate, broker endpoint and device ID, bound to the registration and hub. The private key stays on the board |
| Receive a command | QoS 1 MQTT downlink `{boot_id, command: {id, seq, op, args}}` | The device executes it and returns `{t:"res", id, ok, data}` or an error |
| Report device state and execution | QoS 1 MQTT publish to `devices/<uuid>/up` | The hub processes hello, receipts and events, including drawing events and final OTA results |
| Download an OTA artifact | The bootloader persists the job, destroys its MQTT client and streams an HTTPS GET | After HTTPS cleanup, a terminal MQTT event reports success or failure. Its receipt survives a reboot |

## Command delivery and receipts

The API queues commands in order, including while a device is offline. It waits for a hello on the current broker connection and dispatches one command at a time. The MQTT subscription is `devices/<uuid>/wake`. It carries complete commands, including their arguments, and application ACKs. An idle subscription sends no work requests. MQTT reconnects and cold boots reuse the cached grant. A changed provisioning token or hub requires enrollment. Reissue the registration to replace an unusable certificate.

Commands carry a stable ID, a per-device sequence number and the target boot. A reconnect or missed publication can repeat a dispatch to that boot. The SDK remembers the last sequence across MQTT connections, suppresses duplicate execution and can resend an unacknowledged receipt. A new boot rejects messages addressed to the previous boot. Reboots complete when the hub observes the requested next boot. An install completes on a matching `install.done` or `install.failed` with the original transfer ID, including a receipt delivered by the next boot. The bootloader attempts each installation once. An interrupted transfer reports install.failed with its original transfer ID. To retry, submit a new install request with a new request ID. Verify application startup separately.

The queue expires undelivered commands after five minutes. A dispatched command with no receipt becomes `unknown` after 90 seconds, or ten minutes for an install. A matching late receipt can resolve it. A device alarm and a scheduled sweep retry outstanding work. Reissuing a registration token retires the previous certificate and clears its commands.

## MQTT reports

The shared agent reports the public Bluetooth controller address as `ble_address` in the MQTT hello on each connection. The hub uses the authenticated device ID to update the same binding as USB provisioning. An absent or malformed address leaves the stored value intact. `devices.list` and `devices.get` expose the address for physical registrations.

Each uplink contains a `frame` with a per-boot message ID. The AWS rule attaches the device UUID from the topic and the certificate ID from the broker principal. A Lambda relay forwards the envelope to the Worker. The Worker checks the registered certificate and the active boot. The device policy scopes publish and subscribe to the attached thing.

Hello, command receipts and install outcomes request an application acknowledgement on the downlink. The ACK echoes the boot ID and message ID. The hello acknowledgement confirms that the hub has recorded the boot. A successful OTA write and boot selection completes installation locally. First boot and Hub connectivity do not affect image acceptance. ESP-IDF uses the OTA state `undefined` for images selected with rollback disabled. Ordinary events use MQTT QoS 1.

### Remote console

ESP-IDF task logs (`ESP_LOGx`) use the original console at boot. To redirect them, call `logs.set` with `device_id` and `enabled: true` (requires `devices:write`). Check `commands.get` for the device's receipt. The setting lasts for the current boot, including temporary network outages. Setting `enabled: false`, rebooting, or reloading the device registration discards the buffered tail. The SDK stores nothing in flash. Early ROM and panic output follow their native paths.

Use `logs.read` with `devices:read` to get console batches and structured events, including after the device goes offline. To continue a page, pass its `process_id` and its `cursor` as `after`. R2 records use Hub arrival time and order. New records include the wire `mid` to recover send order within the boot. `dropped_bytes` counts device-side truncation, ring overruns and known send failures. A QoS 0 message can also be lost after publication.

Enabling capture allocates one session with a 2 KiB byte ring, a 384-byte drain buffer and a 672-byte wire buffer. The session uses PSRAM when available, with a heap fallback. Formatting an ESP-IDF log uses a 256-byte buffer on the caller's stack. Python writes go straight into the ring. Producers never publish. The agent handles control first, then drains at most one batch every 250 ms. Each `t: "log"` frame carries Base64 bytes on the existing uplink. Synchronous QoS 0 uses ESP-MQTT's existing transmit buffer, bypassing the JSON event queue and the QoS 1 retransmission outbox. The C library formatter, TLS and network stack have their own working memory.

## Deployment

1. Apply `deploy/iot.yaml` in us-west-2. Set the stack’s `RelaySecret` and the GitHub production environment’s `IOT_RELAY_SECRET` to the same high-entropy secret. The stack uses IAM resources and outputs the managed policy to attach to the Worker AWS principal. Set `UplinkUrl` to the Worker endpoint for that environment.
2. Configure `IOT_ACCOUNT_ID`, `IOT_DATA_ENDPOINT`, `IOT_ACCESS_KEY_ID` and `IOT_SECRET_ACCESS_KEY`. The data endpoint is the regional `iot:Data-ATS` hostname. Use an IAM access key pair for the API Worker.
3. Test the stack, migration, Worker, bootloader and an example application together in a separate environment. Enroll two devices, check isolation across topics, verify a cloud Wi-Fi save and repeated BLE provisioning, then install an image and observe the next boot.

## Local verification

`node scripts/local-e2e.mjs` requires an isolated PostgreSQL database, Chromium, Mosquitto and its command-line clients. The native USB test in `npm test` uses a C compiler, pkg-config and the cJSON development package. It exercises real MQTT QoS 1 traffic over loopback, the production Worker handlers, PostgreSQL and local R2. The fixture emulates AWS enrollment, principal projection and connectivity. Cloud policy enforcement and physical radio behavior require a deployed canary.

## Application messages

Call `devices.send(device_id, payload)` to send an application-defined JSON value (up to 1024 UTF-8 bytes). The tool requires write access and an online physical device. It returns a `message_id` after the broker accepts publication.

The downlink carries `{"boot_id":"…","message":{"id":"…","payload":{}}}` on the existing wake topic. Devices can publish uplink frames with `t:"message"`, `payload`, and an optional `reply_to` containing the downlink ID. Read those messages as structured records from `logs.read`. Both directions use QoS 0 without retention, dispatch retries, or an offline delivery queue.
