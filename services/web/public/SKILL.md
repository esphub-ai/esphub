---
name: esphub
description: Connect a coding agent to EspHub MCP to discover, register, program, and manage ESP32 devices.
---

# EspHub

Use EspHub to inspect and manage the user's ESP32 devices. Start with the action the user asked for. If they asked to set up EspHub, connect and list their devices first.

## Connect

1. Check whether the client already has an EspHub MCP connection. Reuse it if it points to `https://api.esphub.ai/mcp` and is authenticated.
2. Add `https://api.esphub.ai/mcp` as a remote MCP server using Streamable HTTP.
3. Start the client's sign-in flow. Have the user sign in and approve access in the browser.
4. Discover the server's tool schemas and call `devices_list`. Show the device name, board identifier, and online status. Ask which device or task the user wants to work on if they have not already specified it.

### OAuth

EspHub uses Clerk OAuth with Authorization Code and PKCE (S256). The client discovers the authorization server from the MCP endpoint and identifies itself with a Client ID Metadata Document (CIMD). Dynamic Client Registration (DCR) is disabled. Use an MCP client that supports CIMD.

EspHub's default grant includes `devices:read` and `devices:write`. A read-only grant needs additional user consent before write operations such as an active Wi-Fi scan or firmware installation. Clerk uses `offline_access` for token refresh. Device tokens cannot authenticate MCP requests. Keep device tokens and Wi-Fi passwords out of the conversation and logs.

## Bind a new ESP32

First-time setup requires a physical USB connection. If you are running remotely, ask the user to plug the board into their local computer with a USB data cable. Use Computer Use on that same computer to guide the local setup. If you cannot access their computer through Computer Use, guide the user through the local steps and resume once they are done.

1. Identify the exact USB-connected board from its markings or local hardware information. Confirm an ambiguous model with the user. Call `boards_search` with a partial `vendor/model` ID, such as `cardputer`. Use the exact returned ID for registration. Each matching board includes its hardware `spec`, `bootloader` ID, and latest published bootloader download.
2. Ask the user for their Wi-Fi SSID and password, then call `devices_create` with `wifi`. For first-time setup, omit `project_id` so USB flashes only the shared bootloader set and private NVS image with `--erase-all` (keeping the board safely in Bootloader mode until Wi-Fi is verified and the first app is installed). Follow the returned prompt: install esptool, download and verify every file in `flash.files`, obtain confirmation before erasing existing data, and run `flash.command` over USB. Keep the private NVS download credential and `nvs.bin` private and delete `nvs.bin` afterward.
3. After flashing, the board reboots into EspHub Bootloader (`info.role=bootloader`) and attempts to join Wi-Fi. Check `devices_get`:
   - **If `online=true`**: Tell the user the board is online and ready for wireless OTA, and remind them they can unplug the USB cable from the computer (the board only needs power now). Call `projects_search` for the board ID to recommend a few fun published projects as starter examples, and ask which project (via `projects_get` + `ota_install`) or custom app they want to install over OTA.
   - **If `online=false`**: Recover Wi-Fi locally depending on whether the USB cable is still attached (see **Local Wi-Fi provisioning** below). Once `online=true`, proceed straight to the online OTA step above. If setup still fails, report the blocked step and reuse the existing registration when troubleshooting.

### Local Wi-Fi provisioning (USB & BLE)

When a board in EspHub Bootloader mode is offline, scan the 2.4 GHz networks the board can actually see, show those SSIDs to the user, ask them to choose one and enter the password, and join it:

- **USB cable connected (preferred while plugged in):** Open the board's serial port at `115200` baud and exchange newline-terminated `EH-WIFI <json>` commands (responses also start with `EH-WIFI `):
  - Scan: `EH-WIFI {"op":"wifi.scan"}` → returns `{"ssids":[...],"op":"wifi.scan"}`
  - Join: `EH-WIFI {"op":"wifi.join","ssid":"<ssid>","password":"<password>","hidden":false}` (use `""` for open networks; saved to NVS once an IP is obtained)
  - Status: `EH-WIFI {"op":"wifi.status"}` → returns `{"state":"...","connected":"...","hub":true|false,"op":"wifi.status"}`
- **USB cable unplugged (BLE fallback):** Call `wifi_ble_credential` for the device's TLS 1.3 `psk` (PSK identity `"wifi"`), scan BLE for EspHub GATT service `a2eefb31-6c36-481f-ae10-7724fa912101` and read/write characteristic `a2eefb31-6c36-481f-ae10-7724fa912102`, then send the same newline-terminated JSON objects (`{"op":"wifi.scan"}`, `{"op":"wifi.join",...}`, `{"op":"wifi.status"}`) over the TLS 1.3 PSK stream.

After `wifi.status` reports `hub: true` (or `devices_get` shows `online=true`), resume normal wireless OTA.

## Work with an existing device

- **Inspect.** Use `devices_list` and `devices_get` for identity, hardware spec, and state. Use `firmware_get` for device firmware identity and the board's latest bootloader download.
- **Manage Wi-Fi.** Start with `wifi_list`. Use `wifi_scan`, `wifi_add`, or `wifi_remove` as needed. For an offline board, use the USB or BLE flow in **Local Wi-Fi provisioning** above.
- **Resize an application slot.** Read the layout reported by the current Launcher boot. With explicit permission to erase all LittleFS files, call `ota_resize_app` with a 64 KiB-aligned `app_size_bytes` and `erase_littlefs: true`. Growing and shrinking both reset LittleFS. A same-size request preserves it. Wait for the command receipt to confirm the new layout after reboot before installing.
- **Install or develop a board application.** Call `projects_search` (filtered by the board ID) to find published projects, then call `projects_get` to read a project's repository links and per-board `download_url`. For a local or custom binary, upload it with `ota_prepare_upload` to obtain an artifact URL. Enter Bootloader mode with `bootloader_enter`, install with `ota_install` (pass `url` when `kind` is `app`; omit `url` when `kind` is `bootloader` to install the board's latest Launcher), follow `commands_get`, and confirm the firmware version after reboot.
- **Reset or delete.** Confirm the target and effect with the user before `devices_reset` or `devices_delete`. A reset can require USB setup again (or reissuing the setup NVS image through the setup API for the same device ID), and deletion revokes device access.

A queued command is an acknowledgement. Report success only after checking the result and any expected device state.

## Remote console

For a physical device running the EspHub SDK, call `logs_set` with `device_id` and `enabled: true`, then check the receipt with `commands_get`. Ordinary ESP-IDF logs are redirected for this boot. Read `logs_read` and continue with the returned `process_id` and `cursor` (as `after`). Set `enabled: false` to release the capture buffer and restore the local console. Previously uploaded records remain readable while the device is offline.
