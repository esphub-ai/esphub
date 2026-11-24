#!/usr/bin/python3
"""EspHub Wi-Fi setup for the Cardputer Zero launcher."""

import asyncio
import ssl
from contextlib import closing, suppress

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError
from macos import SERVICE, Channel

from hub import Hub, Problem
from screen import Back, Quit, Screen, framebuffer_output, keyboard_device


async def nearby():
    results = await BleakScanner.discover(
        timeout=6, return_adv=True, service_uuids=[SERVICE]
    )
    return sorted(
        (
            (device, adv)
            for device, adv in results.values()
            if SERVICE in adv.service_uuids
        ),
        key=lambda pair: -pair[1].rssi,
    )


class JoinFailed(Problem):
    pass


async def join(session, ssid, password, hidden):
    try:
        await session.request("wifi.join", ssid=ssid, password=password, hidden=hidden)
        async with asyncio.timeout(90):
            while True:
                status = await session.request("wifi.status")
                if status["state"] == "saved" and status["connected"] == ssid:
                    return
                if status["state"] == "failed":
                    raise JoinFailed
                await asyncio.sleep(1)
    except (OSError, BleakError, RuntimeError, ValueError, KeyError):
        raise Problem(
            "Join not confirmed. Check device status before retrying."
        ) from None


async def networks(ui, session):
    choices = []
    while True:
        i = await ui.menu(
            "Wi-Fi on device", ["Scan networks", "Enter SSID manually", *choices]
        )
        if i == 0:
            found = await ui.wait(
                "Scanning Wi-Fi",
                ["The selected device is scanning…"],
                session.request("wifi.scan"),
            )
            choices = list(
                dict.fromkeys(s for s in found["ssids"] if isinstance(s, str) and s)
            )
            if not choices:
                await ui.message(
                    "No networks found", "Rescan or enter the SSID manually."
                )
                continue
            else:
                # Present scan results first, even on a crowded network.
                try:
                    idx = await ui.menu(
                        "Select Wi-Fi", [*choices, "Enter SSID manually"]
                    )
                except Back:
                    continue
                i = idx + 2 if idx < len(choices) else 1
        try:
            manual = i == 1
            ssid = (
                await ui.entry("Network name", "Enter the exact SSID", 32)
                if manual
                else choices[i - 2]
            )
            password = await ui.entry("Wi-Fi password", ssid, 64, masked=True)
        except Back:
            continue
        try:
            await ui.wait(
                "Connecting",
                [ssid, "Waiting for device confirmation…"],
                join(session, ssid, password, manual),
            )
        except JoinFailed:
            await ui.message(
                "Wi-Fi setup failed", "Check the password or select another network."
            )
            continue
        except Back:
            raise Problem(
                "Stopped waiting. The device may still save the network."
            ) from None
        finally:
            password = ""
        await ui.message(
            "Wi-Fi saved", "Device connected to " + ssid + " and saved the network."
        )
        return


class App:
    def __init__(self, ui, hub):
        self.ui, self.hub = ui, hub

    async def login(self):
        grant = await self.ui.wait(
            "EspHub login", ["Requesting a device code…"], self.hub.start()
        )
        await self.ui.wait(
            "Sign in to EspHub",
            [
                "Scan with your phone",
                "accounts.esphub.ai",
                "/device",
                grant["user_code"],
            ],
            self.hub.authorize(grant),
            qr=grant.get("verification_uri_complete") or grant["verification_uri"],
        )

    async def configure(self, device):
        if not self.hub.tokens:
            await self.login()
        devices = await self.ui.wait(
            "Your EspHub devices",
            ["Loading registrations…"],
            self.hub.tool("devices.list"),
        )
        owned = [d for d in devices if d["kind"] == "physical"]
        if not owned:
            raise Problem("No physical devices registered to this account.")
        owner = owned[
            await self.ui.menu(
                "Match registration", [f"{d['name']} · {d['id'][:6]}" for d in owned]
            )
        ]
        cred = await self.ui.wait(
            "Device credential",
            [owner["name"]],
            self.hub.tool("wifi.ble_credential", device_id=owner["id"]),
        )
        client = BleakClient(device, timeout=15)

        async def connect():
            async with asyncio.timeout(45):
                await client.connect()
                channel = Channel(client, bytes.fromhex(cred["psk"]))
                await channel.run(channel.tls.do_handshake)
                return channel

        try:
            try:
                session = await self.ui.wait(
                    "Verify device", [owner["name"], device.address], connect()
                )
            except (ssl.SSLError, BleakError, TimeoutError):
                raise Problem(
                    "Cannot verify this board. Check the selected registration and bootloader."
                ) from None
            await networks(self.ui, session)
        finally:
            if client.is_connected:
                with suppress(BleakError, TimeoutError):
                    async with asyncio.timeout(6):
                        await client.disconnect()

    async def discover(self):
        while True:
            pairs = await self.ui.wait(
                "Nearby devices", ["Scanning EspHub Bluetooth service…"], nearby()
            )
            labels = [f"{dev.address}    {adv.rssi} dBm" for dev, adv in pairs]
            if not pairs:
                await self.ui.message(
                    "No nearby devices",
                    "Open EspHub Bootloader on the target, then scan again.",
                )
            index = await self.ui.menu("Nearby devices", [*labels, "Scan again"])
            if index < len(pairs):
                try:
                    await self.configure(pairs[index][0])
                except Back:
                    pass
                return

    async def run(self):
        while True:
            signed = bool(self.hub.tokens)
            try:
                index = await self.ui.menu(
                    "EspHub Wi-Fi",
                    ["Nearby devices", "Sign out" if signed else "Sign in", "Exit"],
                )
            except Back:
                return
            try:
                if index == 0:
                    await self.discover()
                elif index == 2:
                    return
                elif signed:
                    self.hub.logout()
                else:
                    await self.login()
            except Back:
                pass
            except Problem as e:
                await self.ui.message("EspHub Wi-Fi", str(e))
            except (BleakError, OSError, RuntimeError, KeyError, ValueError):
                await self.ui.message(
                    "Operation interrupted",
                    "Check Bluetooth, network and device mode, then retry.",
                )


async def main():
    with (
        open("/dev/fb_lcd", "r+b", buffering=0) as fb,
        closing(keyboard_device()) as dev,
    ):
        ui = Screen(framebuffer_output(fb))
        dev.grab()
        keys = asyncio.create_task(ui.keyboard(dev))
        app = asyncio.create_task(App(ui, Hub()).run())
        try:
            done, _ = await asyncio.wait(
                (keys, app), return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                task.result()
        finally:
            keys.cancel()
            app.cancel()
            await asyncio.gather(keys, app, return_exceptions=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Quit:
        pass
