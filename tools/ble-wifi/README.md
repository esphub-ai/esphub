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

The bootloader advertises service `a2eefb31-6c36-481f-ae10-7724fa912101`. On a new connection the host writes the 16 decoded bytes of the MCP credential’s `beacon` field to characteristic `a2eefb31-6c36-481f-ae10-7724fa912102`. The first eight bytes are the nonce and the last eight are the truncated HMAC tag. This preface and the subsequent TLS handshake share a 45-second deadline. The board checks the tag and derives the session PSK using the existing `uuid-v1` credential format. The host tries the alternate credential on a fresh connection when key rotation is pending.

TLS bytes use acknowledged writes and reads on the same characteristic, up to 20 bytes at a time. TLS 1.3 uses external PSK identity `wifi`, ephemeral key exchange and AES-128-GCM/SHA-256. The TLS stream carries newline-delimited UTF-8 JSON. A command requires a completed PSK handshake. Use matching bootloader and host-tool versions. Older bootloaders use host-advertised discovery and need the tool from their release.

After MQTT reconnects, the board sends its installed generation in `hello`. Its MQTT ACK can offer a new key. The board saves it to NVS and sends `ble.confirm` over MQTT. The hub retries the same pending key until the board confirms its generation. A credential issued for the previous generation stops working after the device installs the new key. An online device can also save a network remotely through `wifi.add`.
