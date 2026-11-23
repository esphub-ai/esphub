import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { connect } from "./fixtures/ble-provisioning/link.js";
import {
  issueCredential,
  register,
} from "./fixtures/ble-provisioning/protocol.js";

function fixture() {
  const hub = register();
  // Initial USB write copies the device secret only. No saved Wi-Fi or trusted clock.
  const board = {
    keys: { secret: Buffer.from(hub.secret) },
    networks: new Map(),
    connected: null,
    requests: 0,
  };
  return { hub, board };
}

test("first setup, password retry and offline reprovisioning over fragmented TLS", async (t) => {
  const { hub, board } = fixture();
  for (const [ssid, password] of [
    ["First site", "first-site-test-pass"],
    ["New site", "new-site-test-pass"],
  ]) {
    board.networks = new Map([[ssid, password]]);
    board.connected = null;
    const session = await connect(board, issueCredential(hub));
    t.after(session.close);
    assert.equal(session.protocol, "TLSv1.3");
    assert.deepEqual(await session.request({ op: "wifi.scan" }), {
      ssids: [...board.networks.keys()],
    });
    assert.deepEqual(
      await session.request({ op: "wifi.join", ssid, password: "incorrect" }),
      { error: "join failed" },
    );
    assert.equal(board.connected, null);
    assert.deepEqual(
      await session.request({ op: "wifi.join", ssid, password }),
      { connected: ssid },
    );
    assert.equal(board.connected, ssid);
    const wire = Buffer.concat(session.wire);
    for (const privateValue of [ssid, password, "wifi.scan"])
      assert.equal(wire.includes(privateValue), false);
    session.close();
  }
});

test("a recorded beacon opens discovery only; a valid credential is reusable", async (t) => {
  const { hub, board } = fixture();
  const credential = issueCredential(hub);
  assert.notDeepEqual(credential.beacon, issueCredential(hub).beacon);
  for (const beacon of [Buffer.alloc(0), issueCredential(register()).beacon]) {
    await assert.rejects(
      connect(board, { ...credential, beacon }),
      /unknown beacon/,
    );
  }
  await assert.rejects(connect(board, { ...credential, psk: randomBytes(32) }));
  assert.equal(board.requests, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await connect(board, credential);
    t.after(session.close);
    assert.deepEqual(await session.request({ op: "wifi.scan" }), { ssids: [] });
    session.close();
  }
});
