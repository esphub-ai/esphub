# ESP Hub

ESP Hub provisions ESP32 devices over USB and manages them through the web and MCP. This repository owns the production services and launcher firmware.

| Host | Component |
| --- | --- |
| esphub.ai and www.esphub.ai | Website Worker, landing and setup |
| app.esphub.ai | Same website Worker, authenticated device console |
| api.esphub.ai | Separate Hono Worker, device WebSocket and authenticated API |
| api.esphub.ai/mcp | Streamable HTTP JSON-RPC using Clerk OAuth |

## Devices and releases

A chip name is insufficient to choose a launcher. Both supported boards use ESP32-S3 and 16 MB flash. StopWatch requires power-management initialization and its preserved legacy partition layout (application at 0x510000). Paper Color uses the standard layout (application at 0x420000). Each release contains two USB kits with the bootloader, partition table, initial OTA selection, launcher and generated flash arguments, two launcher-only OTA images, and two SHA-256 manifests. USB setup is for first installation; confirm the board and partition map before using it on a previously configured device. Application firmware and MicroPython user scripts have a separate lifecycle. Installing the USB kit alone boots the launcher.

Add a device at app.esphub.ai or via devices.create. Flash the matching kit and send a newline-terminated provisioning record on local USB:

```text
OKL-PROVISION {"hub":"api.esphub.ai","token":"<one-time-token>","wifi":{"ssid":"<network>","pass":"<password>"}}
```

Wait for OKL-PROVISION-OK and the real device hello. The token is accepted only on the device endpoint. The launcher has no Bluetooth provisioning component.

## Console and authentication

Browser sign-in and sign-up use the Clerk production Account Portal at accounts.esphub.ai. Clerk manages sessions across the esphub.ai root domain. The API checks the token signature against clerk.esphub.ai, issuer, expiry and an exact allowed browser origin before mapping a Clerk user ID to a Neon account. The website forwards same-origin requests through its API Worker binding. Connect a remote MCP client from the Devices page and sign in through Clerk. For an existing connection, remove its static Authorization header or bearer-token environment setting before signing in. MCP accepts audience-bound OAuth access tokens for https://api.esphub.ai/mcp. Clients request both devices:read and devices:write by default. Read access covers device and firmware information, saved Wi-Fi networks, boot sessions and serial output. Active Wi-Fi scans, device or network changes, firmware installation and serial input also require devices:write. Existing read-only grants must obtain user consent before a write. Clerk handles consent, token issuance and renewal. A device token cannot access operator tools.

In the ESP Hub production Clerk instance, register https://api.esphub.ai/mcp under Agents → MCP servers and allow public clients to connect with CIMD. Under OAuth applications, create and advertise `devices:read` and `devices:write`. Select both `devices:read` and `devices:write` in the default and allowed scopes for dynamic clients. Clerk uses `offline_access` for token refresh. Use the instance's secret key for the API Worker.

Neon stores registrations, hashed USB device tokens and device ownership. Each device has a Durable Object coordinating the active WebSocket and serial writes. R2 stores RX and TX at devices/{device UUID}/{boot ID}/uart/{rx,tx}. Each small manifest points to the committed record count in bounded 64-record pages. The device polls its RX cursor over its authenticated socket. TX clients poll independently. Writes have an idempotency key and target one live boot. An old boot is read-only. A queued record is not proof of command success. The launcher executes complete command lines; a MicroPython application must include the terminal hook in the application runtime.

## Delivery

Install dependencies with npm ci. npm run build bundles browser code and generates the MCP reference from server tool schemas. npm test runs unit tests, and TEST_DATABASE_URL enables the PostgreSQL ownership test. npm run migrate takes MIGRATION_DATABASE_URL and serializes checksum-verified, additive migrations under an advisory lock.

Pushes to main run verification on an ephemeral PostgreSQL instance, migrate production Neon, deploy the Hono API then the website, and check public domains and authentication boundaries. Required repository secrets are CLERK_SECRET_KEY (ESP Hub production instance), MIGRATION_DATABASE_URL, RUNTIME_DB_PASSWORD (64 lowercase hex characters), and CLOUDFLARE_API_TOKEN. CLOUDFLARE_ACCOUNT_ID is a repository variable. CI ensures the esphub-production R2 bucket exists. The migration role creates a restricted runtime role; the API Worker receives the runtime database URL and the Clerk credential. Configure the production environment to suit the organization's deployment policy.

Firmware changes build on ESP-IDF 5.4.1. A GitHub release is published only after both hardware profiles build. GitHub Releases hosts all firmware packages. The API resolves board-specific assets from GitHub and pins each OTA command to the release tag and its SHA-256. R2 is reserved for UART streams.

## Origin

The board bring-up and launcher SDK are adapted from the MIT-licensed e7h4n/esp-launcher validation project; see firmware/LICENSE. The product reference is https://esphub-device-console.okou.app/. The homepage board image comes from Espressif's ESP32-S3-DevKitC-1 guide. The Instrument Sans font license is included with the web assets.
