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

First-time setup requires a physical USB connection. If you are running remotely, ask the user to plug the board into their local computer with a USB data cable. Use Computer Use on that same computer to guide the local setup, including the local Chrome USB picker when the board instructions use it. Ask the user to select the device and approve access if Chrome requires it. If you cannot access their computer through Computer Use, guide the user through the local steps and resume once they are done.

1. Identify the exact USB-connected board from its markings or local hardware information. Confirm an ambiguous model with the user. Call `boards_search` with a partial `group/project` ID, such as `cardputer`. Use the exact returned ID for registration. Each matching board includes the latest published version and pinned download URL for each available firmware kind.
2. Call `devices_create` for a new registration. Keep the returned device credentials private and follow the returned board-specific setup instructions for the official firmware kit, USB registration, and Wi-Fi. Obtain confirmation before erasing existing data.
3. Use `devices_get` to check that the registered device is online. When the board-specific flow starts an application, check for the expected role in the new session. If setup fails, report the blocked step and reuse the registration when troubleshooting.

## Work with an existing device

- **Inspect.** Use `devices_list` and `devices_get` for identity and state. Use `firmware_get` for board-specific downloads and install guidance.
- **Manage Wi-Fi.** Start with `wifi_list`. Use `wifi_scan`, `wifi_add`, or `wifi_remove` as needed. For an offline board, follow its local provisioning instructions.
- **Resize an application slot.** Read the layout reported by the current Launcher boot. With explicit permission to erase all LittleFS files, call `ota_resize_app` with a 64 KiB-aligned `app_size_bytes` and `erase_littlefs: true`. Growing and shrinking both reset LittleFS. A same-size request preserves it. Wait for the command receipt to confirm the new layout after reboot before installing.
- **Develop a board application.** Choose an example by its capability description in `boards_search`. For a newly registered board, use the exact `setup_example` returned by `devices_create`. Check out its pinned source, open the entrypoint and run the build command. Upload custom binaries with `ota_prepare_upload`. Enter Bootloader mode with `bootloader_enter`, install with `ota_install` (kind `app` or `bootloader`), follow `commands_get` and confirm the firmware version after reboot.
- **Reset, rotate, or delete.** Confirm the target and effect with the user before `devices_reset`, `devices_reissue`, or `devices_delete`. A reset can require USB setup again, and deletion revokes device access.

A queued command is an acknowledgement. Report success only after checking the result and any expected device state.

## Remote console

For a physical device running the EspHub SDK, call `logs_set` with `device_id` and `enabled: true`, then check the receipt with `commands_get`. Ordinary ESP-IDF logs are redirected for this boot. Read `logs_read` and continue with the returned `process_id` and `cursor` (as `after`). Set `enabled: false` to release the capture buffer and restore the local console. Previously uploaded records remain readable while the device is offline.
