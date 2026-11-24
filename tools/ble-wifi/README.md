# ESP Hub Wi-Fi setup on macOS

Use the bootloader and MicroPython images from the latest USB kit for your board. Register with `devices.create` and flash the kit following its INSTALL.txt. On the local USB port at 115200 baud send one newline-terminated record with the returned values:

```text
OKL-PROVISION {"hub":"api.esphub.ai","token":"<token>","ble_secret":"<ble_secret>"}
```

Set `hub` to the plain EspHub hostname. Wait for `OKL-PROVISION-OK`. The device can now receive its first Wi-Fi over Bluetooth.

On a Mac with Python 3.13+ (OpenSSL with PSK support), install Bleak in a virtual environment and grant Bluetooth access to the terminal. Run with a locally authorized Okou CLI:

```sh
python3.13 -m venv .venv
.venv/bin/pip install 'bleak>=1,<4'
.venv/bin/python tools/ble-wifi/macos.py --device DEVICE_UUID
```

The host requests `wifi.ble_credential` from MCP. Alternatively, pipe that tool's private JSON response directly to the script on stdin and omit `--device`. Keep all credential responses private. Keep the device in EspHub Bootloader mode. The Mac scans for the service and authenticates the requested board, including when several boards are nearby. After disconnecting you can run the tool again while the bootloader is running. Select the SSID in the terminal and enter its password at the hidden prompt. The device scans and attempts the connection itself. It reports successful association with an IP and saves the network. An unsuccessful attempt preserves the saved list and can be retried. Check `devices.get` separately for hub reachability.

## Wire protocol

The bootloader advertises service `a2eefb31-6c36-481f-ae10-7724fa912101`. The Mac connects and starts a TLS handshake on characteristic `a2eefb31-6c36-481f-ae10-7724fa912102`. MCP returns a single `psk` field containing the 32-byte HMAC-SHA-256 of the ASCII string `esphub/wifi/tls-psk` under the binary bootstrap key, encoded as hex. The handshake deadline is 45 seconds.

TLS bytes use acknowledged writes and reads on the same characteristic, up to 20 bytes at a time. TLS 1.3 uses external PSK identity `wifi`, ephemeral key exchange and AES-128-GCM/SHA-256. The TLS stream carries newline-delimited UTF-8 JSON. A command requires a completed PSK handshake.

The issued credential remains valid until the device's bootstrap key is replaced or erased. Each connection performs a fresh TLS handshake.

## Cardputer Zero GUI

On a Debian 13 Cardputer Zero, build and install the launcher app:

```sh
tools/ble-wifi/zero/package.sh /tmp/esphub-wifi.deb
sudo apt install /tmp/esphub-wifi.deb
```

Open **EspHub Wi-Fi** in APPLaunch. Choose **Sign in**, scan the QR on a phone
(or visit `accounts.esphub.ai/device` and enter the code), and approve EspHub
device access. The public Clerk client uses the device grant with
`devices:read devices:write offline_access`. Sign out removes the local grant.

1. Put the target in EspHub Bootloader and choose **Nearby devices**. Each
   service advertisement is listed by Bluetooth address and signal strength.
2. Select an advertisement, then choose its registration from your EspHub
   account. Bootloaders advertise a common service UUID. The TLS-PSK handshake
   verifies the selected registration before enabling Wi-Fi operations.
3. Select **Scan networks** to scan on the target or **Enter SSID manually**
   for a hidden network. Enter the network password (empty for an open network).
4. **Wi-Fi saved** appears after the target reports that it saved and connected
   to the selected SSID. If the link is lost after submission, check the device
   before retrying. The app never automatically replays a join.

Use the arrow keys and Enter. Esc goes back, Ctrl+Q exits. Start via APPLaunch
so the launcher releases the physical keyboard and LCD. The Wi-Fi password
and BLE credential are held in memory only. The OAuth grant is stored under
`~/.local/share/esphub-wifi/` with a user-only file mode.
