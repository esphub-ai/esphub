# ESP Hub

ESP Hub provisions ESP32 devices over USB and manages them through the web and MCP. This repository owns the production services and launcher firmware.

| Host | Component |
| --- | --- |
| esphub.ai and www.esphub.ai | Website Worker, landing and setup |
| app.esphub.ai | Same website Worker, authenticated device console |
| api.esphub.ai | Separate Hono Worker, device WebSocket and authenticated API |
| api.esphub.ai/mcp | Streamable HTTP JSON-RPC using Clerk OAuth |

## Devices and releases

All supported models use ESP32-S3. Paper Color and StopWatch have 16 MB flash. Cardputer-Adv has 8 MB flash and its own partition layout. Its MicroPython runtime includes the M5Stack display bindings and the official `hardware.MatrixKeyboard` driver for the TCA8418 keyboard. Identify the physical board before registration. GitHub Releases hosts a board-specific first-time USB kit with the launcher, MicroPython runtime, partition table, flash arguments and a SHA-256 manifest. This kit replaces the partition table and app. The separate StopWatch launcher-only kit preserves its legacy partition layout.

Connect the board over USB and call `devices.create`. Its response includes the device token, setup instructions, release manifest link and a board-specific display verification program. Download the matching kit over HTTPS, flash it, open the launcher USB console at 115200 baud and run `wifi scan`. Select a network or enter a hidden SSID, then submit one newline-terminated JSON record:

```text
OKL-PROVISION {"hub":"api.esphub.ai","token":"<token>","wifi":{"ssid":"<network>","pass":"<password>","hidden":false}}
```

After `OKL-PROVISION-OK`, wait for the online MicroPython app and use the OTA procedure to install the returned verification program. Check the new boot for its board-specific hello message.

## OTA

1. For generated Python, call `programs.publish` with the device ID and UTF-8 source (up to 32 KiB). It returns a private HTTPS URL valid for 24 hours. An existing HTTPS URL also works.
2. Call `launcher.enter` with the device ID. Wait for `devices.get` to report an online launcher. Older launchers can upgrade once with `launcher.install`.
3. Call `ota.install` with `device_id`, `kind` and `url`. Use a matching ESP Hub OTA binary from GitHub Releases for `launcher` or `micropython`, or a plain UTF-8 main.py file for `python`. Boot the matching OTA-capable runtime once to initialize its data volume before installing a program.
4. Read `uart.read` from the returned boot and cursor. Match `install.done` or `install.failed` to the transfer ID. After the reboot, verify the new firmware identity or the program's startup output. A syntax error produces `program.rejected` and preserves the previous main.py.

The launcher validates the HTTPS certificate and hostname and streams in 4 KiB blocks. It checks the board and image type before writing firmware. Launcher updates use the inactive launcher slot. Runtime updates write the application slot, so a failed runtime download may require a retry in launcher mode. Python writes a temporary LittleFS file. The runtime compiles it and atomically replaces main.py before executing it. A program can still fail after it starts. The hub's private artifact endpoint requires the device token. External downloads follow HTTPS redirects without that token.

## Console and authentication

Browser sign-in and sign-up use the Clerk production Account Portal at accounts.esphub.ai. Clerk manages sessions across the esphub.ai root domain. The API checks the token signature against clerk.esphub.ai, issuer, expiry and an exact allowed browser origin before mapping a Clerk user ID to a Neon account. The website forwards same-origin requests through its API Worker binding. Connect a remote MCP client from the Devices page and sign in through Clerk. For an existing connection, remove its static Authorization header or bearer-token environment setting before signing in. MCP accepts audience-bound OAuth access tokens for https://api.esphub.ai/mcp. Clients request both devices:read and devices:write by default. Read access covers device and firmware information, saved Wi-Fi networks, boot sessions and serial output. Active Wi-Fi scans, device or network changes, firmware installation and serial input also require devices:write. Existing read-only grants must obtain user consent before a write. Clerk handles consent, token issuance and renewal. A device token cannot access operator tools.

In the ESP Hub production Clerk instance, register https://api.esphub.ai/mcp under Agents → MCP servers and allow public clients to connect with CIMD. In OAuth applications → Settings, enable Publish CIMD support and leave Publish DCR support off. Use a client version that supports Client ID Metadata Documents (CIMD). Under OAuth applications, create and advertise `devices:read` and `devices:write`. Select both `devices:read` and `devices:write` in the default and allowed scopes for dynamic clients. Clerk uses `offline_access` for token refresh. Use the instance's secret key for the API Worker.

Neon stores registrations, hashed USB device tokens and device ownership. Each device has a Durable Object coordinating the active WebSocket and serial writes. R2 stores RX and TX at devices/{device UUID}/{boot ID}/uart/{rx,tx}. Each small manifest points to the committed record count in bounded 64-record pages. The device polls its RX cursor over its authenticated socket. TX clients poll independently. Writes have an idempotency key and target one live boot. An old boot is read-only. A queued record is not proof of command success. The launcher executes command lines. MicroPython applications read incoming messages with `okou.read_input()` and send output with `print()`.

## Delivery

Install dependencies with npm ci. npm run build bundles browser code and generates the MCP reference from server tool schemas. npm test runs unit tests, and TEST_DATABASE_URL enables the PostgreSQL ownership test. npm run migrate takes MIGRATION_DATABASE_URL and serializes checksum-verified, additive migrations under an advisory lock.

Pushes to main run verification on an ephemeral PostgreSQL instance, migrate production Neon, deploy the Hono API then the website, and check public domains and authentication boundaries. Required repository secrets are CLERK_SECRET_KEY (ESP Hub production instance), MIGRATION_DATABASE_URL, RUNTIME_DB_PASSWORD (64 lowercase hex characters), and CLOUDFLARE_API_TOKEN. CLOUDFLARE_ACCOUNT_ID is a repository variable. CI ensures the esphub-production R2 bucket exists. The migration role creates a restricted runtime role; the API Worker receives the runtime database URL and the Clerk credential. Configure the production environment to suit the organization's deployment policy.

### Board firmware CI

Each directory under `firmware/boards/<id>/` owns a board. It contains the display name, model and chip in `board.json`, the provisioning example in `hello.py`, and the tasks in `ci.json`. Each declared task has its own composite GitHub Action in `<task>/action.yml`. Copy a board directory to add a profile. Give it a unique ID, select its upstream MicroPython target and supply its hardware initialization, partition settings and example. The website, registration schema and firmware workflow discover the directory automatically.

The top-level Board firmware workflow compares each task's build inputs across the push or PR. The per-board workflow calls only the selected local actions. StopWatch's launcher action adds a fresh-layout USB build. Each action can use shared helpers under `.github/actions` or provide its own steps. Set a task's runner, container and extra repository input globs in its board's `ci.json`. Keep board-specific sources under that task's directory.

On main, CI publishes changed artifacts on GitHub Releases under `<component>-<board>-v<version>`. If one component changes, the USB task combines it with the board's previously released counterpart. The manifest records both exact tags. Release notes record input fingerprints to avoid republishing unchanged artifacts. Manual dispatch checks for unpublished inputs and accepts an optional board ID. The release API selects the highest published version containing that model's assets. Historical shared release tags and pinned download URLs stay accessible.

## Origin

The board bring-up and launcher SDK are adapted from the MIT-licensed e7h4n/esp-launcher validation project; see firmware/LICENSE. The product reference is https://esphub-device-console.okou.app/. The homepage board image comes from Espressif's ESP32-S3-DevKitC-1 guide. The Instrument Sans font license is included with the web assets.
