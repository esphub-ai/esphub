# BLE Wi-Fi provisioning simulation

Run `node --test tests/ble-provisioning.test.js` on Node.js 24 or later. This prototype models the computer, device and hub in one process. It exercises Node/OpenSSL TLS 1.3 between two endpoints on an ordered stream with 20-byte fragments. The computer is the TLS client. Only the simulated device scans or joins Wi-Fi.

For the Paper Color implementation, including the macOS UUID format and recovery when rotation is interrupted, see the [host and firmware protocol](../tools/ble-wifi/README.md).

## Protocol

1. On registration, copy a random 32-byte device secret from the hub to the device over USB. The computer does not retain that secret. Provisioning credentials are independent of the existing hub login token.
2. The computer requests a credential over an owner-authorized MCP connection. The simulated issuer starts **after** authorization. It generates a fresh 12-byte nonce. The 24-byte advertising payload contains the nonce followed by the first 12 bytes of HMAC-SHA-256(secret, beacon label || nonce). Only the computer receives the full 32-byte HMAC-SHA-256(secret, session label || nonce) over the private MCP channel. The labels are the ASCII strings `esphub/wifi/v1/beacon` and `esphub/wifi/v1/session`, each followed by one zero byte.
3. After recognizing the beacon, the device derives the same session key. Use it as the external TLS 1.3 PSK with SHA-256. Perform a fresh handshake for each connection. Enable application commands only after the handshake. No early data or shared resumption state is needed. A beacon can be replayed and can prompt a handshake. Possession of the session PSK is required to complete it.
4. Send scan, join and result messages over the encrypted stream. The same credential works again while the device has the same secret. After a successful join and authenticated hub reconnect, rotate the secret. No time-based expiry or list of used credentials is involved.

## Rotation

The hub durably stages one next-generation secret, retransmits that same update until acknowledged and commits it after the device confirms its generation. The device stores generation and secret atomically and accepts a duplicate of the exact installed update. Installing the new generation invalidates previous beacons and authorizations, including further commands on an existing connection. During an unconfirmed rotation, the real issuer should defer new issuance until the hub and device reconcile; an already-issued credential for the previous generation stops working once the device switches. Rotation and its acknowledgement require a separately authenticated device-to-hub channel.

## Scope

USB initialization, MCP authorization and transport, the authenticated rotation channel, persistent writes, BLE advertising/GATT and Wi-Fi radio operations are modeled boundaries. Production integration still needs an actual GATT byte-stream adapter with backpressure and disconnect handling, advertising layout and OS support, device TLS memory/latency measurements, and power-loss tests of atomic secret storage. The issuer must deliver credentials privately and exclude them from logs and model-visible MCP transcripts.
