#!/usr/bin/env python3
"""Paper Color provisioning on macOS. Requires Python >=3.13 and bleak."""
import argparse
import asyncio
import contextlib
import getpass
import json
import ssl
import subprocess
import sys
import uuid

CHANNEL = "a2eefb31-6c36-481f-ae10-7724fa912102"


class Channel:
    """TLS MemoryBIO over ordered, acknowledged GATT writes and bounded reads."""

    def __init__(self, ble, psk):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        # Empty trust store: a certificate-only peer cannot substitute for the PSK.
        context.verify_mode = ssl.CERT_REQUIRED
        context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
        context.set_psk_client_callback(lambda hint: ("wifi", psk))
        self.incoming = ssl.MemoryBIO()
        self.outgoing = ssl.MemoryBIO()
        self.tls = context.wrap_bio(self.incoming, self.outgoing)
        self.ble = ble

    async def flush(self):
        while self.outgoing.pending:
            await self.ble.write_gatt_char(CHANNEL, self.outgoing.read(20), response=True)

    async def run(self, action):
        while True:
            try:
                result = action()
            except ssl.SSLWantReadError:
                await self.flush()
                chunk = await self.ble.read_gatt_char(CHANNEL)
                if chunk:
                    self.incoming.write(chunk)
                else:
                    await asyncio.sleep(0.02)
            else:
                await self.flush()
                return result

    async def request(self, op, **args):
        data = (json.dumps({"op": op, **args}, ensure_ascii=False) + "\n").encode()
        # One bounded application record per request.
        async with asyncio.timeout(45):
            if await self.run(lambda: self.tls.write(data)) != len(data):
                raise RuntimeError("Incomplete TLS write")
            response = bytearray()
            while not response.endswith(b"\n"):
                piece = await self.run(lambda: self.tls.read(4096))
                if not piece or len(response) + len(piece) > 8192:
                    raise RuntimeError("Invalid device response")
                response.extend(piece)
        result = json.loads(response)
        if "error" in result:
            raise RuntimeError(result["error"])
        return result


async def provision(cred):
    import CoreBluetooth as cb
    from Foundation import NSObject, NSRunLoop, NSDate
    from bleak import BleakClient, BleakScanner

    beacon = uuid.UUID(hex=cred["beacon"])
    key = bytes.fromhex(cred["psk"])
    if len(key) != 32:
        raise ValueError("Invalid credential")
    reply = str(uuid.UUID(int=beacon.int ^ (1 << 127)))

    class PeripheralDelegate(NSObject):
        def peripheralManagerDidUpdateState_(self, manager):
            pass

        def peripheralManagerDidStartAdvertising_error_(self, manager, error):
            self.started = True
            self.failed = error is not None

    delegate = PeripheralDelegate.alloc().init()
    delegate.started = delegate.failed = False
    manager = cb.CBPeripheralManager.alloc().initWithDelegate_queue_options_(delegate, None, None)

    async def pump():
        while True:
            NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.002))
            await asyncio.sleep(0.01)

    runloop = asyncio.create_task(pump())
    try:
        async with asyncio.timeout(15):
            while manager.state() in (0, 1):
                await asyncio.sleep(0.05)
        if manager.state() != 5:
            raise RuntimeError("Bluetooth unavailable. Check the Mac's Bluetooth permission and power.")
        manager.startAdvertising_({cb.CBAdvertisementDataServiceUUIDsKey: [cb.CBUUID.UUIDWithString_(str(beacon))]})
        async with asyncio.timeout(10):
            while not delegate.started:
                await asyncio.sleep(0.05)
        if delegate.failed:
            raise RuntimeError("macOS declined Bluetooth advertising")
        device = await BleakScanner.find_device_by_filter(
            lambda _, adv: reply in adv.service_uuids, timeout=40, service_uuids=[reply]
        )
        if not device:
            raise RuntimeError("No matching board replied to this beacon")
        manager.stopAdvertising()
        async with BleakClient(device) as ble:
            session = Channel(ble, key)
            async with asyncio.timeout(45):
                await session.run(session.tls.do_handshake)
            result = await session.request("wifi.scan")
            with open("/dev/tty", "r") as keyboard, open("/dev/tty", "w") as terminal:
                for i, name in enumerate(result["ssids"], 1):
                    print(f"{i}. {name!r}", file=terminal)
                print("Network number, or enter a hidden SSID: ", end="", file=terminal, flush=True)
                choice = keyboard.readline().rstrip("\r\n")
                listed = choice.isdecimal() and 0 < int(choice) <= len(result["ssids"])
                ssid = result["ssids"][int(choice) - 1] if listed else choice
                while True:
                    password = getpass.getpass("Wi-Fi password (empty for open network): ", stream=terminal)
                    await session.request("wifi.join", ssid=ssid, password=password, hidden=not listed)
                    async with asyncio.timeout(90):
                        while True:
                            status = await session.request("wifi.status")
                            if status["state"] == "saved" and status["connected"] == ssid:
                                print("Device saved the network and obtained an IP on the selected Wi-Fi.")
                                return
                            if status["state"] == "failed":
                                print("The board could not join or save the network. Re-enter the password or press Ctrl-C.", file=terminal)
                                break
                            await asyncio.sleep(1)
    finally:
        manager.stopAdvertising()
        runloop.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await runloop


def unwrap(payload):
    # Accept raw operation JSON, native MCP content and Okou's result wrapper.
    if isinstance(payload, dict):
        if "beacon" in payload and "psk" in payload:
            return payload
        for field in ("result", "data", "structuredContent", "content"):
            if field in payload:
                value = unwrap(payload[field])
                if value:
                    return value
        if payload.get("type") == "text":
            return unwrap(json.loads(payload["text"]))
    if isinstance(payload, list):
        for item in payload:
            value = unwrap(item)
            if value:
                return value


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", type=uuid.UUID, help="request the credential using the local Okou CLI (otherwise read JSON on stdin)")
    args = parser.parse_args()
    if args.device:
        reply = subprocess.run(["okou", "mcp", "call", "esphub-mcp", "wifi.ble_credential",
                                "--input", json.dumps({"device_id": str(args.device)}), "--json"],
                               stdout=subprocess.PIPE, check=True)
        payload = json.loads(reply.stdout)
    else:
        payload = json.load(sys.stdin)
    credential = unwrap(payload)
    if not credential:
        sys.exit("Missing BLE credential in MCP response")
    try:
        asyncio.run(provision(credential))
    except TimeoutError:
        sys.exit("Timed out waiting for the device. Verify its connection before retrying.")
