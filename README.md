# EspHub

EspHub provisions ESP32 devices over USB and manages them through the web and MCP. This repository owns the Hub services. Board hardware specs live in [esphub-boards](https://github.com/esphub-ai/esphub-boards), shared bootloaders live in [esphub-bootloader](https://github.com/esphub-ai/esphub-bootloader), and application firmware projects are published through the `/v1/*` Projects API.

| Host | Component |
| --- | --- |
| esphub.ai and www.esphub.ai | Website Worker, landing and setup |
| app.esphub.ai | Same website Worker, authenticated device console |
| api.esphub.ai | Hono Worker, MQTT uplink processing and authenticated API |
| cdn.esphub.ai | Board photos and project images from R2, resized and cached at the Cloudflare edge |
| api.esphub.ai/mcp | Streamable HTTP JSON-RPC using Clerk OAuth |

## Devices and releases

Use `boards_search` to find a board's ID, hardware `spec`, `bootloader` ID, and latest promoted bootloader download. Use `projects_search` and `projects_get` to discover published applications and their per-board `download_url`.

A first install writes two required parts and one optional part:

- **Bootloader set.** Boards with the same bootloader ID (for example `esp32s3-16mb`) share one set: the ESP-IDF second-stage `bootloader.bin`, `partition-table.bin` and the EspHub Launcher. The bootloader publisher records each version in `esphub.bootloaders` and promotes the active pointer in `esphub.bootloader_releases`; `GET /bootloaders/<id>/<version>/<bootloader|partition-table|launcher>` serves the files with immutable caching.
- **Private NVS image.** The Hub generates it per device with the Hub hostname, the device token, the BLE key and the Wi-Fi network. It is downloadable for 15 minutes with its bearer header.
- **Optional Project App (`app.bin`).** By default, first install flashes only the bootloader set and NVS so the board boots directly into the EspHub Launcher and awaits OTA. Pass `project_id` (and optional `version`) to `devices_create` / `POST /setup` / `POST /setup/<device>/reissue` to include a published project's `app.bin` (served from `GET /projects/<id>/boards/<vendor>/<slug>/releases/<version>/app`) in the same USB flash.

Ask the user for the Wi-Fi SSID and password, connect the board over USB and call `devices_create` with `wifi` (and optionally `project_id`). The response's `flash` object lists every file with its offset, URL and sha256 (the NVS entry also carries its headers and `expires_at`), and the matching esptool command. Install esptool with `pip install esptool`, download and verify the files, then run the command, for example:

```sh
esptool.py --chip esp32s3 --port PORT write_flash --erase-all --flash_mode dio --flash_size 16MB --flash_freq 80m 0x0 bootloader.bin 0x8000 partition-table.bin 0x9000 nvs.bin 0x20000 launcher.bin
```

The board starts in the EspHub Bootloader and connects. Confirm `online=true` and `info.role=bootloader` with `devices_get`. If you included a `project_id` in the initial flash, call `bootloader_exit`, type `app` on USB, or power-cycle the board to start the application; otherwise install an app over OTA via `ota_install`. `POST /setup` does the same for the web console, and `POST /setup/<device>/reissue` rotates the device credentials and returns a fresh plan.

From the signed-in EspHub workspace, select **Bind my ESP32** and paste the prompt into your coding agent. The agent can guide board registration, USB setup and Wi-Fi, then confirm the device is online. Use **Manage devices** to open the management prompt.

The bootloader also accepts these newline-terminated JSON commands over USB at 115200 baud. Each response begins with `EH-WIFI ` followed by JSON.

```text
EH-WIFI {"op":"wifi.scan"}
EH-WIFI {"op":"wifi.join","ssid":"My network","password":"<password>","hidden":false}
EH-WIFI {"op":"wifi.status"}
```

For an open network, use an empty password. A join is saved after the device gets an IP address. For direct USB console access, `wifi add <ssid> [password] [hidden]` saves a network immediately. Use the JSON commands for credentials containing spaces. BLE also supports offline setup. On an online device, use `wifi_add` with an SSID and optional password to save a network remotely. Read `commands_get` for the result.

The first-install NVS image and an explicit bootloader entry set a one-shot hold flag. The bootloader consumes it and stays available for that boot. On the next power cycle it starts a valid app, or stays available if the app is missing or invalid. A Hub hello only reports the session.

On ordinary boots, applications use the saved Wi-Fi networks and can initialize their own Bluetooth stack immediately. The bootloader advertises the EspHub provisioning service whenever it is running with a BLE bootstrap key, including when Wi-Fi is already configured. For offline recovery, expose an application menu item or startup key that calls `eh_enter_bootloader()` from the SDK.

Applications with their own Wi-Fi settings screen can call `eh_wifi_join()` and poll `eh_wifi_join_state()`. The station saves credentials after obtaining an IP address.

## Try a virtual ESP32

Call `devices_create_virtual` from an authorized MCP client. Each account can create one private `esphub/virtual-esp32` board. Creating it again returns the same device ID.

1. Call `devices_list` and select the device with `kind: "virtual"`. Use its ID with `firmware_get` to inspect the simulated firmware and current `process_id`.
2. Call `devices_reboot` with that device ID. The response contains the new boot’s `process_id`. Supply a UUID as `request_id` on the first call and reuse it for retries.
3. Use `devices_get` to confirm the new boot ID.

## OTA

1. Use `bootloader_enter` and wait for `devices_get` to show an online device in the bootloader role.
2. Call `ota_install` with kind `app` or `bootloader`.
   - For `kind="app"`, `url` is required: pass a `download_url` or `latest_url` from `projects_get`, an artifact URL from `ota_prepare_upload`, or a direct HTTPS URL.
   - For `kind="bootloader"`, pass an HTTPS URL or omit `url` to install the board’s latest promoted Launcher.
3. Follow the receipt with `commands_get`. Confirm the new process ID and the application version in `devices_get` after reboot.

The EspHub Bootloader checks TLS, the image header and chip, and checks its own variant when updating a bootloader. A bootloader update writes the inactive bootloader slot. An application update writes the single application slot. An interrupted application write can be retried in Bootloader mode. Firmware that crashes after a valid boot can require USB recovery.

### Discover and install a published project

Use `projects_search` (optionally filtered by `board`) to browse public projects, then call `projects_get` with the project's UUID to inspect its description, `repo_url` / `repo_path`, preview images, and per-board releases. Pass the board entry's `download_url` (or `latest_url`) directly to `ota_install` with `kind="app"`.

### Upload a local file

A local build, a downloaded release or a file supplied by the user can all be installed. The build machine needs no GitHub account. If you already have a direct HTTPS download URL accessible to the device, skip the upload step.

1. Call `ota_prepare_upload` with `device_id`, `kind` and the file's exact `size` in bytes. The device can be offline. This requires `devices:write`.
2. PUT the raw file to `upload_url` using the returned `headers.Authorization`. For example, with the response saved privately as `grant.json` and the file path in `FILE`:

   ```sh
   curl --fail-with-body --request PUT --upload-file "$FILE" \
     --header "Authorization: $(jq -r '.headers.Authorization' grant.json)" \
     "$(jq -r '.upload_url' grant.json)"
   ```

   HTTP 201 confirms the bytes are in private R2 storage. The write credential is valid for 15 minutes and can create one object. The device's download URL is valid for 24 hours. App uploads accept up to 32 MiB and bootloader uploads up to 4 MiB. The binary must also fit the board's target partition.
3. Call `bootloader_enter` and wait for Bootloader mode. Pass the upload response's `url` (or an existing direct download URL), `kind` and `device_id` to `ota_install`. Follow the transfer receipt and next boot to verify installation.

### Resize the application slot

Enter Launcher mode and read `info.layout` from the device’s current boot. Call `ota_resize_app` with the device ID, `app_size_bytes` (a multiple of 65536) and `erase_littlefs: true` to move the boundary in either direction. This erases **all** LittleFS files, retains the installed app and provisioning, and reboots into the Launcher. Repeating the current size preserves files. If the current image is too large to shrink, install a smaller app first. Follow the command receipt until the next boot confirms the requested capacities, then install the image. If power is interrupted while rewriting the primary table, recovery may require USB. EspHub supplies the image size for private uploads, official bootloaders, and published project releases. For other HTTPS sources, pass `image_size_bytes` at installation when known. If the source has an unknown length and the stream exceeds the slot, the receipt gives the minimum image size, the current slot, and the maximum supported slot.

## Console and authentication

Browser sign-in and sign-up use the Clerk production Account Portal at accounts.esphub.ai. Clerk manages sessions across the esphub.ai root domain. The API checks the token signature against clerk.esphub.ai, issuer, expiry and an exact allowed browser origin before mapping a Clerk user ID to a Neon account. The website forwards same-origin requests through its API Worker binding. Connect a remote MCP client from the Devices page and sign in through Clerk. MCP accepts audience-bound OAuth access tokens for https://api.esphub.ai/mcp. Clients request both devices:read and devices:write by default. Read access covers device and firmware information, saved Wi-Fi networks and boot metadata. Active Wi-Fi scans, device or network changes, firmware installation also require devices:write. Existing read-only grants must obtain user consent before a write. Clerk handles consent, token issuance and renewal. A device token cannot access operator tools.

In the EspHub production Clerk instance, register https://api.esphub.ai/mcp under Agents → MCP servers and allow public clients to connect with CIMD. In OAuth applications → Settings, enable Publish CIMD support and leave Publish DCR support off. Use a client version that supports Client ID Metadata Documents (CIMD). Under OAuth applications, create and advertise `devices:read` and `devices:write`. Select both `devices:read` and `devices:write` in the default and allowed scopes for dynamic clients. Clerk uses `offline_access` for token refresh. Use the instance's secret key for the API Worker.

Neon stores registrations, device-token hashes, boot metadata and the command queue. Each device’s Durable Object serializes incoming MQTT reports and records structured events in R2.

## Delivery

Install dependencies with `npm ci`. After `npm run migrate`, seed a fresh local database and local R2 with the test board catalog, photos, and bootloader sets using `node scripts/seed-catalog.mjs`. `npm run build` bundles the browser code. npm test runs unit tests, and TEST_DATABASE_URL enables the PostgreSQL tests. npm run migrate takes MIGRATION_DATABASE_URL and serializes checksum-verified migrations under an advisory lock.

Pushes to main run verification on an ephemeral PostgreSQL instance, migrate production Neon, deploy the Hono API then the website, and check public domains and authentication boundaries. Required repository secrets are CLERK_SECRET_KEY (EspHub production instance), CLERK_MACHINE_SECRET_KEY (for the `esphub-api` Clerk Machine), FIRMWARE_R2_ACCESS_KEY_ID and FIRMWARE_R2_SECRET_ACCESS_KEY (Object Read & Write on `esphub-firmware`), MIGRATION_DATABASE_URL, RUNTIME_DB_PASSWORD (64 lowercase hex characters), CLOUDFLARE_API_TOKEN, IOT_RELAY_SECRET (at least 32 characters), IOT_ACCESS_KEY_ID and IOT_SECRET_ACCESS_KEY. CLOUDFLARE_ACCOUNT_ID, IOT_ACCOUNT_ID and IOT_DATA_ENDPOINT are repository variables. The API Worker stores uploads and logs in the esphub-production R2 bucket and reads/publishes releases and board photos in the esphub-firmware bucket (with a 1-day lifecycle rule on `staging/uploads/`). Both buckets must exist before the first deploy. Internal bootloader publishing (`POST /internal/uploads`, `POST /internal/bootloaders`, `PUT /internal/bootloaders/:id/current`) is authenticated with Clerk M2M tokens scoped to `esphub-api` from the configured bootloader machine ID. The migration role creates a restricted runtime role; the API Worker receives the runtime database URL and the Clerk credential. Configure the production environment to suit the organization's deployment policy.

Board hardware definitions and photos live in [esphub-boards](https://github.com/esphub-ai/esphub-boards), which syncs `photo.webp` files to `boards/<vendor>/<slug>.webp` in the `esphub-firmware` R2 bucket and upserts structured board records into `esphub.boards` using a least-privilege database role (`esphub_boards_publisher`). Shared bootloader sets are built and published by [esphub-bootloader](https://github.com/esphub-ai/esphub-bootloader) into `esphub.bootloaders` and `esphub.bootloader_releases`. `GET /boards` and the read-only MCP tool `boards_search` read active boards directly from `esphub.boards` and `esphub.bootloader_releases`, returning `spec`, `bootloader`, `product_url`, `image_url`, and the active bootloader download. `GET /boards/<vendor>/<slug>` returns a single board's hardware spec, bootloader binding and active bootloader version. `GET /boards/gallery` reads active photographed boards directly from `esphub.boards`. The gallery and device cards request bounded WebP thumbnails from `cdn.esphub.ai` using `?width=`. Cloudflare Images resizes them from R2 on a CDN cache miss. Opening a board shows its original photo. A missing photo returns 404 and is omitted from the wall.

## Projects API (`/v1/*`)

Multi-board firmware projects are owned by personal EspHub accounts (`esphub.projects`, `esphub.project_images`, `esphub.project_releases`, `esphub.project_boards`) and published through `/v1/*` using a Clerk personal API Key (`ak_...`, enabled in Clerk Dashboard) or Web Clerk Session Token:

- `POST /v1/uploads` — declares each file's `size` and `content_type` (`application/octet-stream` up to 32 MiB, or `image/webp`/`image/png`/`image/jpeg` up to 5 MiB) and returns UUID-based presigned R2 staging PUT URLs (`staging/uploads/<uuid>`) with `Content-Type` and `Content-Length` signed into `X-Amz-SignedHeaders`.
- `POST /v1/projects`, `GET /v1/projects`, `GET /v1/projects/:id`, `PUT /v1/projects/:id`, `DELETE /v1/projects/:id` — allocate a project UUID, list/inspect owned projects (including unpublished drafts), update metadata and up to 10 preview images (with optional cover selection), and soft-archive.
- `POST /v1/projects/:id/releases`, `PUT /v1/projects/:id/boards/:vendor/:slug/current`, `DELETE /v1/projects/:id/boards/:vendor/:slug` — publish immutable per-board `app.bin` releases (with optional `app_elf_sha256`, `idf_version`, `source_revision`), switch/roll back the active version pointer, or unlink a board while keeping historical release downloads intact.
- Public read and CDN routes (no prefix): `GET /projects`, `GET /projects/:id`, `GET /projects/:id/boards/:vendor/:slug/app`, `GET /projects/:id/boards/:vendor/:slug/releases/:version/app`, and `https://cdn.esphub.ai/projects/:id/images/:sha256.:ext` (immutable, supports `?width=` WebP resizing).
- MCP tools: `projects_list`, `projects_create`, `projects_get`, `projects_search`; `ota_install` resolves `app_size` and verifies target board compatibility automatically for `https://api.esphub.ai/projects/...` URLs.
