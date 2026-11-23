# EspHub

EspHub provisions ESP32 devices over USB and manages them through the web and MCP. This repository owns the production services and launcher firmware.

| Host | Component |
| --- | --- |
| esphub.ai and www.esphub.ai | Website Worker, landing and setup |
| app.esphub.ai | Same website Worker, authenticated device console |
| api.esphub.ai | Hono Worker, MQTT uplink processing and authenticated API |
| api.esphub.ai/mcp | Streamable HTTP JSON-RPC using Clerk OAuth |

See the [firmware glossary and partition mapping](docs/firmware-terminology.md) for the EspHub Bootloader, SDK, Runtime, and Program types.

## Devices and releases

All supported models use ESP32-S3. Paper Color, PaperDIY, StackChan and StopWatch have 16 MB flash. Cardputer-Adv has 8 MB flash and its own partition layout. Its MicroPython runtime includes the M5Stack display bindings and the official `hardware.MatrixKeyboard` driver for the TCA8418 keyboard. Identify the physical board before registration. GitHub Releases hosts a board-specific first-time USB kit with the shared launcher, MicroPython runtime, partition table, board identity, example main.py, flash arguments and a SHA-256 manifest. This kit replaces the partition table and app. The separate StopWatch launcher-only kit preserves its legacy partition layout.

To build the shared launcher locally, use ESP-IDF 5.4.1 from the selected `firmware/bootloader/<target>-<size>mb/` directory. Use `esp32s3-8mb` for Cardputer-Adv and `esp32s3-16mb` for the other boards:

```sh
cd firmware/bootloader/esp32s3-16mb
idf.py build
```

Connect the board over USB and call `devices.create`. Download and flash the matching setup kit. Send the returned token and BLE bootstrap key to the launcher at 115200 baud:

```text
OKL-PROVISION {"hub":"api.esphub.ai","token":"<token>","ble_secret":"<ble_secret>"}
```

The USB `hub` setting takes a plain hostname such as `api.esphub.ai`. A scheme, port or path is rejected. An existing URL-valued setting requires writing the hostname over USB. OTA artifacts still use full HTTPS URLs.

After `OKL-PROVISION-OK`, start the Mac BLE tool, wait for **Beacon ready**, restart the board, and choose a network or enter a hidden SSID and password locally. Then wait for the online MicroPython app and use the OTA procedure to install the returned verification program. Check the new boot for its board-specific hello message.

On an online device, use `wifi.add` with an SSID and optional password to save a network remotely. Read `commands.get` for the result. First-time and offline setup use the [Mac BLE tool](tools/ble-wifi/README.md).

## Try a virtual ESP32

Sign in, open **Devices**, and select **Create virtual ESP32**, or call `devices.create_virtual` from an authorized MCP client. Each account can create one private board. Creating it again returns the same device ID.

1. Call `devices.list` and select the device with `kind: "virtual"`. Use its ID with `firmware.get` to inspect the simulated firmware and current `process_id`.
2. Call `devices.reboot` with that device ID. The response contains the new boot’s `process_id`. Supply a UUID as `request_id` on the first call and reuse it for retries.
3. Pass the device and process IDs to `uart.read` to see the restart log. `uart.sessions` lists the saved boots, newest first. Boot history persists across logins until the device is deleted.

The virtual board supports read-only serial output and private 24-hour source staging with `programs.publish`. Running MicroPython, writing serial input, Wi-Fi/BLE operations and flashing firmware require physical hardware.

## OTA

On an existing board with the single-slot layout, install the latest board MicroPython runtime before upgrading to the shared launcher. That runtime saves the board identity in NVS when it writes the new launcher. OTA preserves the existing partition table and credentials. For a first install, the board-specific USB setup kit writes the board identity directly.

1. For a local firmware binary, use `ota.prepare_upload` and PUT the file as described below. If you already have an HTTPS download URL, use it directly. For generated Python, call `programs.publish` with the device ID and UTF-8 source (up to 32 KiB). It returns a private HTTPS URL valid for 24 hours. An existing HTTPS URL also works.
2. Call `launcher.enter` with the device ID. Wait for `devices.get` to report an online launcher. For the official launcher, use `ota.install` with `kind: "launcher"` and omit the URL.
3. Call `ota.install` with `device_id`, `kind` and `url`. Use a matching official or custom-built OTA binary for `launcher` or `micropython`, or a plain UTF-8 main.py file for `python`. Boot the matching OTA-capable runtime once to initialize its data volume before installing a program.
4. Read the install result with `commands.get`. The boot performing the write reports `install.done` with the total bytes written or `install.failed` with the error. To inspect the event, match the transfer ID in that boot's `uart.read` stream (Runtime for Bootloader updates, Bootloader for Runtime and Python Program updates). After reboot, verify the new firmware identity or the program's startup output. An uncaught exception in boot.py or main.py produces a `program.failed` event and a traceback in the application log.

The launcher validates the HTTPS certificate and hostname and streams in 4 KiB blocks. It checks the board and image type before writing firmware. New USB layouts reserve one 1.25 MiB partition named `bl` for the EspHub Bootloader and a partition named `app` for the application image. For launcher OTA, the launcher saves the URL and transfer ID and boots the matching MicroPython runtime in maintenance mode. Its native agent downloads into the same launcher partition and boots the validated image. A running compatible runtime can also accept `ota.install` directly for `kind: "launcher"`, including to retry an interrupted write. An interruption can leave the launcher unusable until the runtime retries the OTA or the device is recovered by USB.

On a device with the older A/B layout, update the runtime first, then the launcher. Subsequent updates overwrite the last booted launcher in place. OTA does not rewrite the partition table or move user files. To reclaim the reserved Flash on an existing device, back up its files and reinstall the new first-time USB kit. For a 4 MiB board with a compact runtime, `firmware/partitions/4mb.csv` allocates 1.25 MiB for the launcher, 2.0625 MiB for the runtime, and 512 KiB for user files. Current board-specific runtime releases exceed that runtime budget. Both OTA firmware images must carry the board profile and the single-slot capability marker emitted by this SDK.

Runtime updates write the application slot, so a failed runtime download may require a retry in launcher mode. Python streams directly into main.py. Starting the write replaces the old source. Wait for output from the next application boot to verify execution. The hub's private artifact endpoint requires the device token. External downloads follow HTTPS redirects without that token.

### Build your own update

Call `devices.get` to get `sources.launcher`, `sources.micropython` and `sources.python` for the registered board, including when it is offline. These are starting points in the official repository. The Python link opens the board's starter program. Keep your own modified source in your repository.

| OTA kind | What to edit | What to send |
| --- | --- | --- |
| `launcher` | Shared EspHub Bootloader source in `firmware/bootloader/common/`, board flash layout under `firmware/board/<vendor>/<model>/layout/`, and the hub protocol in `firmware/components/okou_agent/` | The board's `*-ota.bin` release asset |
| `micropython` | Runtime integration in `firmware/pyrt/`, the board's `micropython/` directory and the linked UIFlow MicroPython upstream. To build a modified upstream, set the repository and commit in `firmware/pyrt/upstream.json`. | The board's `esphub-<board>-micropython-<version>.bin` release asset |
| `python` | Start from the linked `main.py` or write your own UTF-8 `main.py`. | The script itself, ready to run without compilation |

To build a binary with GitHub Actions, optionally fork this repository, enable GitHub Actions in the fork, and commit your changes. Run **Actions → Board firmware → Run workflow** on your fork's `main` branch and enter the public board ID (for example, `paper-color`). The workflow builds missing or changed components, checks their board and image profiles, and publishes them to your fork's Releases. A main-branch push that touches firmware also starts this workflow. The build needs permission to write repository contents. Preserve the target chip, existing partition layout and `ESPHUB1/<kind>/<board>` image descriptor. Retain the hub connection and launcher-entry protocol if you want to manage the new firmware remotely.

### Upload a local file

A local build, a downloaded release or a file supplied by the user can all be installed. The build machine needs no GitHub account. If you already have a direct HTTPS download URL accessible to the device, skip the upload step.

1. Call `ota.prepare_upload` with `device_id`, `kind` and the file's exact `size` in bytes. The device can be offline. This requires `devices:write`.
2. PUT the raw file to `upload_url` using the returned `headers.Authorization`. For example, with the response saved privately as `grant.json` and the file path in `FILE`:

   ```sh
   curl --fail-with-body --request PUT --upload-file "$FILE" \
     --header "Authorization: $(jq -r '.headers.Authorization' grant.json)" \
     "$(jq -r '.upload_url' grant.json)"
   ```

   HTTP 201 confirms the bytes are in private R2 storage. The write credential is valid for 15 minutes and can create one object. The device's download URL is valid for 24 hours. Use `programs.publish` for Python source up to 32 KiB. Firmware uploads accept up to 4 MiB. The binary must also fit the board's target partition.
3. Call `launcher.enter` and wait for launcher mode. Pass the upload response's `url` (or an existing direct download URL), `kind` and `device_id` to `ota.install`. Follow the transfer receipt and next boot to verify installation.

## Console and authentication

Browser sign-in and sign-up use the Clerk production Account Portal at accounts.esphub.ai. Clerk manages sessions across the esphub.ai root domain. The API checks the token signature against clerk.esphub.ai, issuer, expiry and an exact allowed browser origin before mapping a Clerk user ID to a Neon account. The website forwards same-origin requests through its API Worker binding. Connect a remote MCP client from the Devices page and sign in through Clerk. For an existing connection, remove its static Authorization header or bearer-token environment setting before signing in. MCP accepts audience-bound OAuth access tokens for https://api.esphub.ai/mcp. Clients request both devices:read and devices:write by default. Read access covers device and firmware information, saved Wi-Fi networks, boot sessions and serial output. Active Wi-Fi scans, device or network changes, firmware installation and serial input also require devices:write. Existing read-only grants must obtain user consent before a write. Clerk handles consent, token issuance and renewal. A device token cannot access operator tools.

In the ESP Hub production Clerk instance, register https://api.esphub.ai/mcp under Agents → MCP servers and allow public clients to connect with CIMD. In OAuth applications → Settings, enable Publish CIMD support and leave Publish DCR support off. Use a client version that supports Client ID Metadata Documents (CIMD). Under OAuth applications, create and advertise `devices:read` and `devices:write`. Select both `devices:read` and `devices:write` in the default and allowed scopes for dynamic clients. Clerk uses `offline_access` for token refresh. Use the instance's secret key for the API Worker.

Neon stores registrations, device-token hashes, boot metadata and the command queue. Each device’s Durable Object serializes incoming MQTT reports and records serial output in R2. Serial input uses the same per-boot command queue as other remote operations. [Device protocol and rollout](docs/iot.md).

## Delivery

Install dependencies with npm ci. npm run build bundles browser code and generates the tool catalog for the signed-in explorer. npm test runs unit tests, and TEST_DATABASE_URL enables the PostgreSQL ownership test. npm run migrate takes MIGRATION_DATABASE_URL and serializes checksum-verified, additive migrations under an advisory lock.

Pushes to main run verification on an ephemeral PostgreSQL instance, migrate production Neon, deploy the Hono API then the website, and check public domains and authentication boundaries. Required repository secrets are CLERK_SECRET_KEY (ESP Hub production instance), MIGRATION_DATABASE_URL, RUNTIME_DB_PASSWORD (64 lowercase hex characters), and CLOUDFLARE_API_TOKEN. CLOUDFLARE_ACCOUNT_ID is a repository variable. CI ensures the esphub-production R2 bucket exists. The migration role creates a restricted runtime role; the API Worker receives the runtime database URL and the Clerk credential. Configure the production environment to suit the organization's deployment policy.

### Board firmware CI

Each `firmware/board/<vendor>/<model>/board.json` declares the board's chip, flash capacity, and shared bootloader variant. The directory name supplies the public board ID unless `board.json` sets a unique `id`. The board directory owns its partition layout, MicroPython hardware configuration, verification example, and MicroPython and USB setup actions.

The firmware workflow builds each selected variant once from `firmware/bootloader/<target>-<size>mb/`. On main it publishes the bootloader binaries under an input-fingerprinted `bl-*` tag. Later runs reuse the published binaries when preparing a board with the same variant and build inputs. The shared builds use internal RAM.

The board workflow combines the shared binaries with each board's partition table, and publishes board-facing assets under `<component>-<board>-v<version>`. StopWatch also gets a fresh-layout USB archive using the same launcher binary. USB setup includes the board's MicroPython image and verification example. Its manifest pins both component tags. Historical board download URLs continue to resolve.

## Origin

The board bring-up and launcher SDK are adapted from the MIT-licensed e7h4n/esp-launcher validation project; see firmware/LICENSE. The product reference is https://esphub-device-console.okou.app/. The homepage board image comes from Espressif's ESP32-S3-DevKitC-1 guide. The Instrument Sans font license is included with the web assets.
