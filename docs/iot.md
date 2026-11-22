# Physical device protocol

The launcher and MicroPython share one device agent. Firmware keeps a single authenticated MQTT session with AWS IoT Core in us-west-2. A device needs its registration token and P-256 key to enroll. USB installs the initial registration token and BLE bootstrap key. The virtual ESP32 has no device credentials or network transport.

| Operation | Device path | Evidence of completion |
| --- | --- | --- |
| Connect to a Wi-Fi network on site | BLE scan and join using an MCP-issued credential | The board reports the join result over the encrypted BLE session |
| Save a network remotely | Cloud `wifi.add`, delivered through the command queue | MQTT receipt after the NVS write. The password is removed from the queue upon dispatch |
| Rotate BLE credentials | HTTPS `POST /api/device/ble/sync` | The device reports its installed generation. The hub commits the pending key after confirmation and retries the same outstanding offer |
| Enroll or reconnect to MQTT | HTTPS `POST /api/device/iot/enroll` with CSR and boot ID | Certificate and broker endpoint. The private key stays on the board |
| Receive a command | MQTT wake followed by HTTPS `POST /api/device/iot/pull` | The pull returns one command and records its dispatch |
| Report device state and execution | QoS 1 MQTT publish to `devices/<uuid>/up` | The hub processes hello, receipts, logs, metrics and events, including drawing and OTA progress and completion |
| Download an OTA artifact | Stream an HTTPS GET with board and image checks | Matching install result, then verification of the next boot |
| Inspect resident main.py | Runtime-only authenticated HTTPS PUT of the file snapshot | `programs.get` returns the source and process ID |

## Command delivery and receipts

The API commits the command before publishing a wake. The device pulls on subscription, on a wake, and after completing work. Pull selects the oldest eligible command and atomically changes its state from `queued` to `dispatched`. A request ID identifies one command and payload. Concurrent pulls and retries cannot dispatch that command twice.

`dispatched` means the server returned the command for delivery. An interrupted pull can leave the board without the command. The server reports `unknown` after the receipt deadline and never automatically replays dispatched work. Queued commands expire after five minutes. A valid late receipt can resolve an unknown result. Reboots complete when the requested next boot is observed. Install commands complete on a matching `install.done` or `install.failed` event. Check the next boot separately to verify that the program started.

A Durable Object alarm retries queued wakes. A periodic sweep also recovers interrupted alarms and certificate revocations. Reissuing a token invalidates pending commands and the previous certificate.

## MQTT reports

Devices subscribe to their own `devices/<uuid>/wake` topic. A pending notification carries no command or credentials. Each uplink contains a `frame` with a per-boot message ID. The AWS rule attaches the device UUID from the topic and the certificate ID from the broker principal. A Lambda relay forwards that envelope to the Worker. The Worker verifies the relay, registered certificate and enrolled boot. The device policy scopes publish and subscribe to the attached thing.

Hello, command receipts, install outcomes and log batches request an application acknowledgement on the existing downlink. The ACK echoes the boot and message ID. Hello confirms the hub has recorded the boot before firmware can cancel rollback. Log acknowledgements carry the stored source sequence. Metrics and ordinary events need only MQTT QoS 1. Periodic logging captures a finite batch every ten minutes. An empty buffer produces no upload. `logs.flush` requests a batch immediately. Unacknowledged RAM logs can be lost on a power cut.

## Deployment

1. Apply `deploy/iot.yaml` in us-west-2. Set the stack’s `RelaySecret` and the GitHub production environment’s `IOT_RELAY_SECRET` to the same high-entropy secret. The stack uses IAM resources and outputs the managed policy to attach to the Worker AWS principal. Set `UplinkUrl` to the Worker endpoint for that environment.
2. Configure `IOT_ACCOUNT_ID`, `IOT_DATA_ENDPOINT`, `IOT_ACCESS_KEY_ID` and `IOT_SECRET_ACCESS_KEY`. The data endpoint is the regional `iot:Data-ATS` hostname. Temporary AWS credentials also require `IOT_SESSION_TOKEN`.
3. Test the stack, migration, Worker, launcher and MicroPython together in a separate environment. Enroll two devices, check isolation across topics, verify a cloud Wi-Fi save and a BLE rotation, then install an image and observe the next boot.
4. Coordinate the production cutover. Existing firmware depends on removed endpoints; firmware for both boot roles and the new backend must be available together. Stage both images using the old control plane or arrange local USB recovery before switching the production Worker. Carry active work through to a terminal result before migration. The migration retires ambiguous in-flight work as unknown.

## Local verification

`node scripts/local-e2e.mjs` requires an isolated PostgreSQL database, Chromium, Mosquitto and its command-line clients. It exercises real MQTT QoS 1 traffic over loopback, the production Worker handlers, PostgreSQL and local R2. The fixture emulates AWS enrollment, principal projection and connectivity. Cloud policy enforcement and physical radio behavior require a deployed canary.
