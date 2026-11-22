# ESP Hub

ESP Hub provisions ESP32 devices over USB and manages them through the web and MCP. This repository owns the production services and launcher firmware.

| Host | Component |
| --- | --- |
| esphub.ai and www.esphub.ai | Website Worker, landing and setup |
| app.esphub.ai | Same website Worker, authenticated device console |
| api.esphub.ai | Separate Hono Worker, device WebSocket and authenticated API |
| api.esphub.ai/mcp | Streamable HTTP JSON-RPC using an account developer key |

## Devices and releases

A chip name is insufficient to choose a launcher. Both supported boards use ESP32-S3 and 16 MB flash. StopWatch requires power-management initialization and its preserved legacy partition layout (application at 0x510000). Paper Color uses the standard layout (application at 0x420000). Each release contains two USB kits with the bootloader, partition table, initial OTA selection, launcher and generated flash arguments, two launcher-only OTA images, and two SHA-256 manifests. USB setup is for first installation; confirm the board and partition map before using it on a previously configured device. Application firmware and MicroPython user scripts have a separate lifecycle. Installing the USB kit alone boots the launcher.

Add a device at app.esphub.ai or via devices.create. Flash the matching kit and send a newline-terminated provisioning record on local USB:

```text
OKL-PROVISION {"hub":"api.esphub.ai","token":"<one-time-token>","wifi":{"ssid":"<network>","pass":"<password>"}}
```

Wait for OKL-PROVISION-OK and the real device hello. The token is accepted only on the device endpoint. The launcher has no Bluetooth provisioning component.

## Console and authentication

Browser accounts use platform passkeys. The API verifies challenges, relying-party ID and origin, and issues a secure HTTP-only session. The website proxies same-origin API requests via a Worker service binding. Issue a developer bearer key from Account to use MCP. Reissuing a key revokes the previous key. A device token cannot access operator tools.

Neon stores registrations, hashed credentials and ownership. Each device has a Durable Object coordinating the active WebSocket and serial writes. R2 stores RX and TX at devices/{device UUID}/{boot ID}/uart/{rx,tx}. Each small manifest points to the committed record count in bounded 64-record pages. The device polls its RX cursor over its authenticated socket. TX clients poll independently. Writes have an idempotency key and target one live boot. An old boot is read-only. A queued record is not proof of command success. The launcher executes complete command lines; a MicroPython application must include the terminal hook in the application runtime.

## Delivery

Install dependencies with npm ci. npm run build bundles browser code and generates the MCP reference from server tool schemas. npm test runs unit tests, and TEST_DATABASE_URL enables the PostgreSQL ownership test. npm run migrate takes MIGRATION_DATABASE_URL and serializes checksum-verified, additive migrations under an advisory lock.

Pushes to main run verification on an ephemeral PostgreSQL instance, migrate production Neon, deploy the Hono API then the website, and check public domains and authentication boundaries. Required repository secrets are MIGRATION_DATABASE_URL, RUNTIME_DB_PASSWORD (64 lowercase hex characters), and CLOUDFLARE_API_TOKEN. CLOUDFLARE_ACCOUNT_ID is a repository variable. CI ensures the esphub-production R2 bucket exists. The migration role creates a restricted runtime role; only the runtime URL is sent to the API Worker. Configure the production environment to suit the organization's deployment policy.

Firmware changes build on ESP-IDF 5.4.1. A GitHub release is published only after both hardware profiles build. The downloads workflow verifies asset digests, uploads the files to R2, then replaces the latest catalog. The website serves board-specific download links through the API.

## Origin

The board bring-up and launcher SDK are adapted from the MIT-licensed e7h4n/esp-launcher validation project; see firmware/LICENSE. The product reference is https://esphub-device-console.okou.app/. The homepage board image comes from Espressif's ESP32-S3-DevKitC-1 guide. The Instrument Sans font license is included with the web assets.
