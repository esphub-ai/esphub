# ESP Hub Wi-Fi setup on macOS

Use the launcher and MicroPython images from the latest USB kit for your board. Register with `devices.create` and flash the kit following its INSTALL.txt. On the local USB port at 115200 baud send one newline-terminated record with the returned values:

```text
OKL-PROVISION {"hub":"api.esphub.ai","token":"<token>","ble_secret":"<ble_secret>"}
```

Wait for `OKL-PROVISION-OK`. The device can now receive its first Wi-Fi over Bluetooth. For an existing registration with older firmware, install both updated images and use `devices.reissue` to get new USB credentials. Reissuing disconnects the old registration token. Complete the USB write before moving the device.

On a Mac with Python 3.13+ (OpenSSL with PSK support), install Bleak in a virtual environment and grant Bluetooth access to the terminal. Run with a locally authorized Okou CLI:

```sh
python3.13 -m venv .venv
.venv/bin/pip install 'bleak>=1,<4'
.venv/bin/python tools/ble-wifi/macos.py --device DEVICE_UUID
```

The host requests `wifi.ble_credential` from MCP. Alternatively, pipe that tool's private JSON response directly to the script on stdin and omit `--device`. Keep all credential responses private. Wait for **Beacon ready**, then restart the board. A board provisioned over USB reads the saved key at startup, scans for up to 12 seconds and powers down BLE after discovery times out or the provisioning session ends. To retry, restart the host tool and then the board. Select the SSID in the terminal and enter its password at the hidden prompt. The device scans and attempts the connection itself. It reports successful association with an IP and saves the network. An unsuccessful attempt preserves the saved list and can be retried. Check `devices.get` separately for hub reachability.

## Wire protocol

CoreBluetooth can advertise a custom service UUID. The `uuid-v1` format uses one 128-bit UUID, containing eight random nonce bytes followed by the first eight bytes of HMAC-SHA-256 over the nonce with the beacon label. The independent 32-byte session PSK uses the session label. Both use the current device secret as key. Labels are ASCII `esphub/wifi/uuid-v1/beacon` and `esphub/wifi/uuid-v1/session`, each followed by a zero byte. UUID field ordering uses canonical UUID bytes, reversed only at the NimBLE boundary. The prototype's 24-byte advertisement used a different label and format.

The matching device advertises the same UUID with its most significant bit toggled. The host connects and carries TLS bytes over acknowledged writes and reads on characteristic `a2eefb31-6c36-481f-ae10-7724fa912102`, up to 20 bytes at a time. TLS 1.3 uses external PSK identity `wifi`, ephemeral key exchange and AES-128-GCM/SHA-256. The TLS stream carries newline-delimited UTF-8 JSON. Seeing a beacon can trigger discovery; a command requires a completed PSK handshake.

After Wi-Fi reconnects or a BLE session ends, the board sends its installed generation to `POST /api/device/ble/sync` over HTTPS. The hub retries the same pending key until the board confirms its generation. A credential issued for the previous generation stops working after the device installs the new key. An online device can also save a network remotely through `wifi.add`.
