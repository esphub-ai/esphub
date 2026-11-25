---
name: esphub
description: Connect a coding agent to EspHub MCP to discover, register, program, and manage ESP32 devices.
---

# EspHub

Use EspHub to inspect and manage the user's ESP32 devices. Start with the action the user asked for. If they asked to set up EspHub, connect and list their devices first.

## Connect

1. Check whether the client already has an EspHub MCP connection. Reuse it if it points to `https://api.esphub.ai/mcp` and is authenticated.
2. Add `https://api.esphub.ai/mcp` as a remote MCP server using Streamable HTTP. If migrating an existing connection, remove any static Authorization header or bearer-token setting so the client can start OAuth.
3. Start the client's sign-in flow. Have the user sign in and approve access in the browser.
4. Discover the server's tool schemas and call `devices.list`. Show the device name, board identifier, and online status. Ask which device or task the user wants to work on if they have not already specified it.

### OAuth

EspHub uses Clerk OAuth with Authorization Code and PKCE (S256). The client discovers the authorization server from the MCP endpoint and identifies itself with a Client ID Metadata Document (CIMD). Dynamic Client Registration (DCR) is disabled. Use an MCP client that supports CIMD.

EspHub's default grant includes `devices:read` and `devices:write`. A read-only grant needs additional user consent before write operations such as an active Wi-Fi scan or firmware installation. Clerk uses `offline_access` for token refresh. Device tokens cannot authenticate MCP requests. Keep device tokens and Wi-Fi passwords out of the conversation and logs.

## Bind a new ESP32

First-time setup requires a physical USB connection. If you are running remotely, ask the user to plug the board into their local computer with a USB data cable. Use Computer Use on that same computer to guide the local setup, including the local Chrome USB picker when the board instructions use it. Ask the user to select the device and approve access if Chrome requires it. If you cannot access their computer through Computer Use, guide the user through the local steps and resume once they are done.

1. Identify the exact USB-connected board from its markings or local hardware information. Confirm an ambiguous model with the user. Choose a value from the live `devices.create` board enum. Use the `group/project` identifier where the server provides one, such as `m5stack/cardputer-adv`.
2. Call `devices.create` for a new registration. Keep the returned device credentials private and follow the returned board-specific setup instructions for the official firmware kit, USB registration, and Wi-Fi. Obtain confirmation before erasing existing data.
3. Use `devices.get` to check that the registered device is online. When the board-specific flow starts an application, check for the expected role in the new session. If setup fails, report the blocked step and reuse the registration when troubleshooting.

## Work with an existing device

- **Inspect.** Use `devices.list` and `devices.get` for identity and state. Use `firmware.get` for board-specific downloads and install guidance.
- **Manage Wi-Fi.** Start with `wifi.list`. Use `wifi.scan`, `wifi.add`, or `wifi.remove` as needed. For an offline board, follow its local provisioning instructions.
- **Install a program.** Confirm the target and firmware kind. Stage Python with `programs.publish` or upload a supported binary using `ota.prepare_upload`. Enter Bootloader mode with `bootloader.enter`, wait for the board to report that role, then call `ota.install` with the matching kind and URL. For queued work, read `commands.get` until terminal. Verify the installed program or firmware and the next session with `programs.get` or `devices.get` as appropriate.
- **Reset, rotate, or delete.** Confirm the target and effect with the user before `devices.reset`, `devices.reissue`, or `devices.delete`. A reset can require USB setup again, and deletion revokes device access.

A queued command is an acknowledgement. Report success only after checking the result and any expected device state.
