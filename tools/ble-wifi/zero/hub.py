"""Production EspHub OAuth device grant and stateless MCP client."""

import asyncio
import json
import os
import tempfile
import time
from pathlib import Path

import requests

ISSUER = "https://clerk.esphub.ai"
MCP = "https://api.esphub.ai/mcp"
CLIENT = Path(__file__).with_name("client-id").read_text().strip()
SCOPE = "devices:read devices:write offline_access"


class Problem(Exception):
    """Safe user-facing error."""


async def post(url, **options):
    try:
        return await asyncio.to_thread(
            requests.post, url, timeout=(8, 25), allow_redirects=False, **options
        )
    except requests.RequestException:
        raise Problem("Network unavailable. Check Zero's Wi-Fi.") from None


class Hub:
    def __init__(self):
        self.path = Path.home() / ".local/share/esphub-wifi/grant.json"
        self.tokens = {}
        try:
            self.tokens = json.loads(self.path.read_text())
        except (FileNotFoundError, ValueError):
            pass

    def save(self, data):
        if not data.get("access_token"):
            raise Problem("Clerk returned an incomplete grant.")
        data = {
            key: data[key]
            for key in ("access_token", "refresh_token", "expires_in")
            if key in data
        }
        data["expires"] = time.time() + int(data.pop("expires_in", 300))
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, self.path)
        finally:
            Path(name).unlink(missing_ok=True)
        self.tokens = data

    def logout(self):
        self.path.unlink(missing_ok=True)
        self.tokens = {}

    async def start(self):
        r = await post(
            ISSUER + "/oauth/device_authorization",
            data={"scope": SCOPE, "client_id": CLIENT, "resource": MCP},
        )
        if r.status_code != 200:
            raise Problem(f"Cannot start Clerk login (HTTP {r.status_code}).")
        return r.json()

    async def authorize(self, grant):
        interval = max(1, grant.get("interval", 5))
        deadline = time.monotonic() + grant["expires_in"]
        while time.monotonic() + interval < deadline:
            await asyncio.sleep(interval)
            r = await post(
                ISSUER + "/oauth/token",
                data={
                    "client_id": CLIENT,
                    "device_code": grant["device_code"],
                    "resource": MCP,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
            )
            if r.status_code == 200:
                self.save(r.json())
                return
            error = r.json().get("error")
            if error == "slow_down":
                interval += 5
            elif error != "authorization_pending":
                raise Problem("Login denied or expired. Start again.")
        raise Problem("Login code expired. Start again.")

    async def token(self):
        if self.tokens.get("expires", 0) > time.time() + 30:
            return self.tokens["access_token"]
        refresh = self.tokens.get("refresh_token")
        if not refresh:
            raise Problem("Please sign in to EspHub.")
        r = await post(
            ISSUER + "/oauth/token",
            data={
                "client_id": CLIENT,
                "refresh_token": refresh,
                "resource": MCP,
                "grant_type": "refresh_token",
            },
        )
        if r.status_code != 200:
            if r.status_code == 400 and r.json().get("error") == "invalid_grant":
                self.logout()
            raise Problem("Could not renew login. Retry or sign in again.")
        data = r.json()
        data.setdefault("refresh_token", refresh)
        self.save(data)
        return self.tokens["access_token"]

    async def tool(self, name, **args):
        token = await self.token()
        headers = {
            "Authorization": "Bearer " + token,
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
        }
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": args},
        }
        r = await post(MCP, headers=headers, json=payload)
        if r.status_code != 200:
            raise Problem(f"EspHub {name} failed (HTTP {r.status_code}).")
        if r.headers.get("Content-Type", "").startswith("text/event-stream"):
            replies = (
                json.loads(line[5:])
                for line in r.text.splitlines()
                if line.startswith("data:") and line[5:].strip()
            )
            reply = next((item for item in replies if item.get("id") == 1), {})
        else:
            reply = r.json()
        result = reply.get("result", {})
        if not result.get("content") or result.get("isError"):
            raise Problem(f"EspHub denied {name}. Check registration and account.")
        return json.loads(result["content"][0]["text"])
