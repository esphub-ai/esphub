# EspHub

EspHub provisions ESP32 devices over USB and manages them through the web and MCP. This repository owns the Hub services. Board firmware lives in [esphub-firmware](https://github.com/esphub-ai/esphub-firmware).

| Host | Component |
| --- | --- |
| esphub.ai and www.esphub.ai | Website Worker, landing and setup |
| app.esphub.ai | Same website Worker, authenticated device console |
| api.esphub.ai | Hono Worker, MQTT uplink processing and authenticated API |
| cdn.esphub.ai | Board photos from R2, resized and cached at the Cloudflare edge |
| api.esphub.ai/mcp | Streamable HTTP JSON-RPC using Clerk OAuth |

See the [firmware glossary and partition mapping](docs/firmware-terminology.md) for the EspHub Bootloader, SDK, and applications.

## Devices and releases

Use `boards.search` to find a board and its examples. Each entry includes a capability description, the upstream reference, a revision-pinned source URL, an entrypoint and a build command. The [board matrix](https://github.com/esphub-ai/esphub-firmware/blob/main/docs/m5stack-boards.md) maps hardware revisions and bundles to board IDs.

`devices.create` registers the chosen board and returns a pinned USB setup manifest and its `setup_example`. The kit contains the EspHub Bootloader, the partition table and the board’s default application. Its manifest records the SHA-256 of both the kit and the application. Verify the kit hash before flashing. Installation erases the board.

To build the shared bootloader locally, check out [esphub-firmware](https://github.com/esphub-ai/esphub-firmware) at the revision in the board's `sources.bootloader.directory_url` and use ESP-IDF 5.4.1 from the selected `firmware/bootloader/<target>-<size>mb/` directory. Use ESP-IDF 5.5.4 for `esp32c5-16mb` and `esp32c61-16mb`. Select the `bootloader` identifier from the board’s `firmware/board/<group>/<project>/board.json`. For example, build the 16 MiB ESP32-S3 variant with the following command.

```sh
cd firmware/bootloader/esp32s3-16mb
idf.py build
```

Connect the board over USB and call `devices.create`. Download and flash the matching setup kit. Pipe the private registration result into `python3 provision_usb.py PORT` from the kit (requires pyserial and an authenticated Okou CLI). This sends the token and BLE bootstrap key at 115200 baud and binds the returned Bluetooth address to the registration through MCP. The USB request is:

```text
EH-PROVISION {"hub":"api.esphub.ai","token":"<token>","ble_secret":"<ble_secret>"}
```

The USB `hub` setting takes a plain hostname such as `api.esphub.ai`. OTA artifacts use full HTTPS URLs.

After `EH-PROVISION-OK`, run the Mac BLE tool while the board is in the bootloader and choose a network or enter a hidden SSID and password locally. Then call `bootloader.exit`, type `app` on USB, or power-cycle the board to start the application. Confirm that `devices.get` reports an online app and the version in the manifest. Check the behavior described in `setup_example.description`.

From the signed-in EspHub workspace, select **Bind my ESP32** and paste the prompt into your coding agent. The agent can guide board registration, USB setup and Wi-Fi, then confirm the device is online. Use **Manage devices** to open the management prompt.

The bootloader also accepts these newline-terminated JSON commands over USB at 115200 baud. Each response begins with `EH-WIFI ` followed by JSON.

```text
EH-WIFI {"op":"wifi.scan"}
EH-WIFI {"op":"wifi.join","ssid":"My network","password":"<password>","hidden":false}
EH-WIFI {"op":"wifi.status"}
```

For an open network, use an empty password. A join is saved after the device gets an IP address. For direct USB console access, `wifi add <ssid> [password] [hidden]` saves a network immediately. Use the JSON commands for credentials containing spaces. BLE also supports offline setup. On an online device, use `wifi.add` with an SSID and optional password to save a network remotely. Read `commands.get` for the result.

The first-time kit and an explicit bootloader entry set a one-shot hold flag. The bootloader consumes it and stays available for that boot. On the next power cycle it starts a valid app, or stays available if the app is missing or invalid. A Hub hello only reports the session.

On ordinary boots, applications use the saved Wi-Fi networks and can initialize their own Bluetooth stack immediately. The bootloader advertises the EspHub provisioning service whenever it is running with a BLE bootstrap key, including when Wi-Fi is already configured. For offline recovery, expose an application menu item or startup key that calls `eh_enter_bootloader()` from the SDK.

Applications with their own Wi-Fi settings screen can call `eh_wifi_join()` and poll `eh_wifi_join_state()`. The station saves credentials after obtaining an IP address.

## Try a virtual ESP32

Sign in, open **Devices**, and select **Create virtual ESP32**, or call `devices.create_virtual` from an authorized MCP client. Each account can create one private `esphub/virtual-esp32` board. Creating it again returns the same device ID.

1. Call `devices.list` and select the device with `kind: "virtual"`. Use its ID with `firmware.get` to inspect the simulated firmware and current `process_id`.
2. Call `devices.reboot` with that device ID. The response contains the new boot’s `process_id`. Supply a UUID as `request_id` on the first call and reuse it for retries.
3. Use `devices.get` to confirm the new boot ID.

## OTA

1. Use `bootloader.enter` and wait for `devices.get` to show an online device in the bootloader role.
2. Call `ota.install` with kind `app` or `bootloader`. Omit `url` to install the board’s published image. For custom firmware, pass an HTTPS URL or upload the image as described below.
3. Follow the receipt with `commands.get`. Confirm the new process ID and the application version in `devices.get` after reboot.

The EspHub Bootloader checks TLS, the image header and chip, and checks its own variant when updating a bootloader. A bootloader update writes the inactive bootloader slot. An application update writes the single application slot. An interrupted application write can be retried in Bootloader mode. Firmware that crashes after a valid boot can require USB recovery.

### Build your own update

Use `setup_example` for the exact sources of a newly installed kit. For another example use `boards.search` or `devices.get`, pick an entry by description, check out the revision in its `source_url` and edit its `entrypoint`. Run its `build_command` from the firmware repository root. The [build guide](https://github.com/esphub-ai/esphub-firmware/blob/main/docs/build-examples.md) describes the toolchain. Use kind `app` for the resulting image.

### Upload a local file

A local build, a downloaded release or a file supplied by the user can all be installed. The build machine needs no GitHub account. If you already have a direct HTTPS download URL accessible to the device, skip the upload step.

1. Call `ota.prepare_upload` with `device_id`, `kind` and the file's exact `size` in bytes. The device can be offline. This requires `devices:write`.
2. PUT the raw file to `upload_url` using the returned `headers.Authorization`. For example, with the response saved privately as `grant.json` and the file path in `FILE`:

   ```sh
   curl --fail-with-body --request PUT --upload-file "$FILE" \
     --header "Authorization: $(jq -r '.headers.Authorization' grant.json)" \
     "$(jq -r '.upload_url' grant.json)"
   ```

   HTTP 201 confirms the bytes are in private R2 storage. The write credential is valid for 15 minutes and can create one object. The device's download URL is valid for 24 hours. App uploads accept up to 32 MiB and bootloader uploads up to 4 MiB. The binary must also fit the board's target partition.
3. Call `bootloader.enter` and wait for Bootloader mode. Pass the upload response's `url` (or an existing direct download URL), `kind` and `device_id` to `ota.install`. Follow the transfer receipt and next boot to verify installation.

## Console and authentication

Browser sign-in and sign-up use the Clerk production Account Portal at accounts.esphub.ai. Clerk manages sessions across the esphub.ai root domain. The API checks the token signature against clerk.esphub.ai, issuer, expiry and an exact allowed browser origin before mapping a Clerk user ID to a Neon account. The website forwards same-origin requests through its API Worker binding. Connect a remote MCP client from the Devices page and sign in through Clerk. For an existing connection, remove its static Authorization header or bearer-token environment setting before signing in. MCP accepts audience-bound OAuth access tokens for https://api.esphub.ai/mcp. Clients request both devices:read and devices:write by default. Read access covers device and firmware information, saved Wi-Fi networks and boot metadata. Active Wi-Fi scans, device or network changes, firmware installation also require devices:write. Existing read-only grants must obtain user consent before a write. Clerk handles consent, token issuance and renewal. A device token cannot access operator tools.

In the EspHub production Clerk instance, register https://api.esphub.ai/mcp under Agents → MCP servers and allow public clients to connect with CIMD. In OAuth applications → Settings, enable Publish CIMD support and leave Publish DCR support off. Use a client version that supports Client ID Metadata Documents (CIMD). Under OAuth applications, create and advertise `devices:read` and `devices:write`. Select both `devices:read` and `devices:write` in the default and allowed scopes for dynamic clients. Clerk uses `offline_access` for token refresh. Use the instance's secret key for the API Worker.

Neon stores registrations, device-token hashes, boot metadata and the command queue. Each device’s Durable Object serializes incoming MQTT reports and records structured events in R2. [Device protocol and rollout](docs/iot.md).

## Delivery

Install dependencies with `npm ci`. After `npm run migrate`, seed a fresh local database with the test board catalog using `node scripts/seed-catalog.mjs` and import the local R2 gallery with `node scripts/migrate-board-gallery.mjs --local`. `npm run build` bundles the browser code. npm test runs unit tests, and TEST_DATABASE_URL enables the PostgreSQL ownership test. npm run migrate takes MIGRATION_DATABASE_URL and serializes checksum-verified migrations under an advisory lock.

Pushes to main run verification on an ephemeral PostgreSQL instance, migrate production Neon, deploy the Hono API then the website, and check public domains and authentication boundaries. Required repository secrets are CLERK_SECRET_KEY (EspHub production instance), MIGRATION_DATABASE_URL, RUNTIME_DB_PASSWORD (64 lowercase hex characters), and CLOUDFLARE_API_TOKEN. CLOUDFLARE_ACCOUNT_ID is a repository variable. CI ensures the esphub-production R2 bucket exists. The migration role creates a restricted runtime role; the API Worker receives the runtime database URL and the Clerk credential. Configure the production environment to suit the organization's deployment policy.

Firmware builds, SDK version automation and release publication live in [esphub-firmware](https://github.com/esphub-ai/esphub-firmware). The firmware repository publishes board profiles, example and source links, and an index of every published release file to Neon. The Hub serves the directory and downloads from these records and R2, without contacting GitHub or deriving release names. `GET /boards` and the read-only MCP tool `boards.search` use the same directory. A query such as `{"query":"paper"}` matches the literal substring in board IDs. Each result includes its R2 photo and the latest published version and pinned download URL for each available firmware kind. Upload a board photo as `boards/<group>/<project>.webp` in the `esphub-firmware` bucket. The website loads `GET /boards/gallery`, which joins current boards and their manufacturer product links with the available R2 photos. Set a manufacturer link in `esphub.board_product_pages`. The gallery and device cards request bounded WebP thumbnails from `cdn.esphub.ai` using `?width=`. Cloudflare Images resizes them from R2 on a CDN cache miss. Opening a board shows its original photo. A missing photo returns 404 and is omitted from the wall.

## Origin

The board bring-up and bootloader SDK are adapted from the MIT-licensed e7h4n/esp-bootloader validation project; see [firmware/LICENSE](https://github.com/esphub-ai/esphub-firmware/blob/main/firmware/LICENSE). The product reference is https://esphub-device-console.okou.app/. The Instrument Sans font license is included with the web assets.

### Resize the application slot

Enter Launcher mode and read `info.layout` from the device’s current boot. Call `ota_resize_app` with the device ID, `app_size_bytes` (a multiple of 65536) and `erase_littlefs: true` to move the boundary in either direction. This erases **all** LittleFS files, retains the installed app and provisioning, and reboots into the Launcher. Repeating the current size preserves files. If the current image is too large to shrink, install a smaller app first. Follow the command receipt until the next boot confirms the requested capacities, then install the image. If power is interrupted while rewriting the primary table, recovery may require USB. EspHub supplies the image size for private uploads and official releases. For other HTTPS sources, pass `image_size_bytes` at installation when known. If the source has an unknown length and the stream exceeds the slot, the receipt gives the minimum image size, the current slot, and the maximum supported slot.
