import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { connect } from "./fixtures/ble-provisioning/link.js";
import {
  acknowledgeRotation,
  installRotation,
  issueCredential,
  prepareRotation,
  register,
} from "./fixtures/ble-provisioning/protocol.js";

function fixture() {
  const hub = register();
  // Initial USB write copies the device secret only. No saved Wi-Fi or trusted clock.
  const board = {
    keys: { generation: hub.generation, secret: Buffer.from(hub.secret) },
    networks: new Map(),
    connected: null,
    requests: 0,
  };
  return { hub, board };
}

test("first setup, password retry and offline reprovisioning over fragmented TLS", async (t) => {
  let { hub, board } = fixture();
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
    hub = prepareRotation(hub);
    board.keys = installRotation(board.keys, hub.pending);
    hub = acknowledgeRotation(hub, board.keys.generation);
  }
});

test("a recorded beacon opens discovery only; a valid same-generation credential is reusable", async (t) => {
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

test("rotation recovers from lost acknowledgement and revokes used and unused credentials", async (t) => {
  let { hub, board } = fixture();
  const used = issueCredential(hub),
    unused = issueCredential(hub);
  const active = await connect(board, used);
  t.after(active.close);
  await active.request({ op: "wifi.scan" });
  hub = prepareRotation(hub);
  assert.equal(prepareRotation(hub), hub);
  assert.throws(() => issueCredential(hub), /rotation pending/);
  board.keys = installRotation(board.keys, hub.pending);
  // Simulated restart after the durable device write, before receipt reaches the hub.
  board.keys = {
    generation: board.keys.generation,
    secret: Buffer.from(board.keys.secret),
  };
  assert.equal(
    installRotation(board.keys, prepareRotation(hub).pending),
    board.keys,
  );
  await assert.rejects(active.request({ op: "wifi.scan" }), /session closed/);
  for (const old of [used, unused])
    await assert.rejects(connect(board, old), /unknown beacon/);
  hub = acknowledgeRotation(hub, board.keys.generation);
  assert.equal(acknowledgeRotation(hub, board.keys.generation), hub);
  assert.throws(() =>
    installRotation(board.keys, { generation: 1, secret: randomBytes(32) }),
  );
  const fresh = await connect(board, issueCredential(hub));
  t.after(fresh.close);
  assert.deepEqual(await fresh.request({ op: "wifi.scan" }), { ssids: [] });
});
