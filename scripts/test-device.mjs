import assert from "node:assert/strict";
import postgres from "postgres";
import { setTimeout as delay } from "node:timers/promises";
import { simulatedDevice } from "../tests/fixtures/iot/device.mjs";
import { importPKCS8, SignJWT } from "jose";
import { createHmac, randomUUID } from "node:crypto";
const base = process.env.TEST_SITE_URL;
if (!base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("A local TEST_SITE_URL is required");
const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
const endpoint = "https://api.esphub.ai/mcp";
const issuer = "https://clerk.esphub.ai";
const otherSubject = "user_" + randomUUID().replaceAll("-", "");
const subject = "user_" + randomUUID().replaceAll("-", "");
const privateKey = await importPKCS8(process.env.TEST_SIGNING_KEY, "RS256");
function issue(scope, overrides = {}, typ = "at+jwt") {
  return new SignJWT({
    iss: issuer,
    aud: endpoint,
    sub: subject,
    jti: randomUUID(),
    client_id: "test-public-client",
    scope,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ })
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "5m")
    .sign(privateKey);
}
const key = await issue("devices:read devices:write");
async function request(method, params, accessToken = key) {
  return fetch(base + "/backend/mcp", {
    method: "POST",
    headers: {
      ...(accessToken && { Authorization: "Bearer " + accessToken }),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
async function message(response) {
  const body = await response.text();
  return JSON.parse(
    body.startsWith("event:") || body.startsWith("id:")
      ? body
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6)
      : body,
  );
}
async function call(method, params, accessToken) {
  const r = await request(method, params, accessToken);
  const msg = await message(r);
  assert.equal(r.status, 200, JSON.stringify(msg));
  assert.ok(!msg.error, JSON.stringify(msg));
  return msg.result;
}
async function op(name, args, accessToken) {
  const r = await call("tools/call", { name, arguments: args }, accessToken);
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
}
async function testVirtualDevice(read) {
  const createVirtual = () => op("devices_create_virtual", {});
  const [virtual, duplicate] = await Promise.all([
    createVirtual(),
    createVirtual(),
  ]);
  assert.deepEqual(virtual, duplicate);
  assert.equal(virtual.kind, "virtual");
  assert.equal(virtual.board, "esphub/virtual-esp32");
  const vid = { device_id: virtual.id };
  const firmware = await op("firmware_get", vid, read);
  const [listedVirtual] = await op("devices_list", {}, read);
  assert.equal(listedVirtual.kind, "virtual");
  assert.equal(listedVirtual.process_id, firmware.process_id);
  assert.equal(listedVirtual.info.fw.name, "EspHub virtual firmware");
  assert.deepEqual(listedVirtual.info.fw, firmware.fw);
  assert.deepEqual(
    (
      await sql`SELECT token_hash,ble_secret,cert_id FROM esphub.devices WHERE id=${virtual.id}`
    )[0],
    { token_hash: null, ble_secret: null, cert_id: null },
  );
  const rebootArgs = { ...vid, request_id: randomUUID() };
  const [restart, retry] = await Promise.all([
    op("devices_reboot", rebootArgs),
    op("devices_reboot", rebootArgs),
  ]);
  assert.deepEqual(retry, restart);
  assert.notEqual(restart.process_id, firmware.process_id);
  const later = await op("devices_reboot", vid);
  assert.deepEqual(await createVirtual(), virtual);
  assert.deepEqual(await op("devices_reboot", rebootArgs), restart);
  const reconnected = await issue("devices:read");
  const current = await op("devices_get", vid, reconnected);
  assert.equal(current.process_id, later.process_id);
  const secondAccount = await issue("devices:read devices:write", {
    sub: otherSubject,
  });
  assert.deepEqual(await op("devices_list", {}, secondAccount), []);
  const secondBoard = await op("devices_create_virtual", {}, secondAccount);
  assert.notEqual(secondBoard.id, virtual.id);
  for (const name of [
    "devices_get",
    "devices_reboot",
    "devices_delete",
  ]) {
    const result = await call(
      "tools/call",
      { name, arguments: vid },
      secondAccount,
    );
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /Device not found/, name);
  }
  for (const [name, args] of [
    ["devices_bind_ble_address", { ...vid, ble_address: "02:11:22:33:44:55" }],
    ["wifi_scan", vid],
    ["wifi_ble_credential", vid],
    ["devices_reissue", vid],
    ["bootloader_enter", vid],
    ["bootloader_exit", vid],
    ["ota_install", { ...vid, kind: "app" }],
    ["ota_resize_app", { ...vid, app_size_bytes: 0x400000 }],
  ]) {
    const result = await call("tools/call", { name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /requires a physical device/, name);
  }
  await op("devices_delete", vid);
  assert.deepEqual(await op("devices_list", {}, read), []);
  assert.equal(
    (
      await sql`SELECT 1 FROM esphub.virtual_boots WHERE device_id=${virtual.id}`
    ).length,
    0,
  );
}

let mcu;
try {
  const discovery = await (
    await fetch(base + "/backend/.well-known/oauth-protected-resource/mcp")
  ).json();
  assert.equal(discovery.resource, endpoint);
  assert.deepEqual(discovery.scopes_supported, [
    "devices:read",
    "devices:write",
    "offline_access",
  ]);
  assert.deepEqual(discovery.authorization_servers, [issuer]);
  const read = await issue("devices:read");
  const anonymousCall = await request(
    "tools/call",
    { name: "devices_list", arguments: {} },
    null,
  );
  assert.equal(anonymousCall.status, 401);
  assert.match(
    anonymousCall.headers.get("WWW-Authenticate"),
    /scope="devices:read devices:write offline_access"/,
  );
  for (const invalid of [
    await issue("devices:read", { aud: "https://another.example/mcp" }),
    await issue("devices:read", { aud: undefined }),
    await issue("devices:read", { exp: 1 }),
    await issue("devices:read", { sid: "sess_fixture" }, "JWT"),
  ]) {
    const denied = await request("tools/list", {}, invalid);
    assert.equal(denied.status, 401);
    assert.match(
      denied.headers.get("WWW-Authenticate"),
      /oauth-protected-resource/,
    );
  }
  const list = await request(
    "tools/call",
    { name: "devices_list", arguments: {} },
    read,
  );
  assert.equal(list.status, 200);
  assert.deepEqual(
    JSON.parse((await message(list)).result.content[0].text),
    [],
  );
  const listed = (await call("tools/list", {})).tools;
  assert.ok(listed.some(({ name }) => name === "ota_resize_app"));
  assert.deepEqual((await call("tools/list", {}, null)).tools, listed);
  const readOnly = new Set([
    "boards_search",
    "commands_get",
    "devices_list",
    "devices_get",
    "wifi_list",
    "firmware_get",
    "logs_read",
  ]);
  const matches = await op("boards_search", { query: "CaRdPuTeR" }, read);
  const publicMatches = await (await fetch(base + "/backend/boards?q=CaRdPuTeR")).json();
  assert.deepEqual(matches, publicMatches);
  assert.deepEqual(publicMatches.map(b => b.id).sort(), ["m5stack/cardputer", "m5stack/cardputer-adv"]);
  const additiveTools = new Set([
    "wifi_ble_credential",
    "devices_create",
    "devices_create_virtual",
    "devices_send",
    "ota_prepare_upload",
    "logs_set",
  ]);
  const openWorldTools = new Set([
    "wifi_scan",
    "wifi_add",
    "ota_install",
  ]);
  for (const { name, annotations } of listed) {
    // Active Wi-Fi discovery observes nearby networks but still requires write scope.
    const observesOnly = readOnly.has(name) || name === "wifi_scan";
    assert.equal(annotations?.readOnlyHint, observesOnly, name);
    assert.equal(
      annotations?.destructiveHint,
      !observesOnly && !additiveTools.has(name),
      name,
    );
    assert.equal(annotations?.openWorldHint, openWorldTools.has(name), name);
  }
  for (const { name } of listed.filter((t) => !readOnly.has(t.name))) {
    const denied = await request("tools/call", { name, arguments: {} }, read);
    assert.equal(denied.status, 403, name);
    const challenge = denied.headers.get("WWW-Authenticate");
    assert.match(challenge, /insufficient_scope/);
    assert.match(challenge, /devices:read/);
    assert.match(challenge, /devices:write/);
    assert.match(challenge, /oauth-protected-resource/);
  }
  // An MCP access token is not a console session.
  const apiDenied = await fetch(base + "/backend/operations/devices_list", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(apiDenied.status, 401);
  assert.equal(
    (
      await call("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "integration", version: "1.0.0" },
      })
    ).serverInfo.name,
    "esphub",
  );
  await testVirtualDevice(read);
  const d = await op("devices_create", {
      board: "m5stack/paper-color",
      name: "Simulator",
    }),
    id = { device_id: d.id };
  assert.match(d.prompt, /hidden SSID/);
  assert.match(d.ble_secret, /^[0-9a-f]{64}$/);
  const usbAddress = "02:AA:BB:CC:DD:EE";
  const reportedAddress = "02:11:22:AA:BB:CC";
  const bindArgs = { ...id, ble_address: usbAddress };
  assert.equal((await op("devices_get", id)).ble_address, null);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await op("devices_bind_ble_address", bindArgs), {
      id: d.id, ble_address: usbAddress.toLowerCase(),
    });
  }
  await assert.rejects(op("devices_bind_ble_address", { ...id, ble_address: "wrong" }), /Invalid ble_address/);
  assert.equal((await op("devices_list", {}, read))[0].ble_address, usbAddress.toLowerCase());
  const firstBle = await op("wifi_ble_credential", id);
  assert.deepEqual(firstBle, {
    psk: createHmac("sha256", Buffer.from(d.ble_secret, "hex"))
      .update("esphub/wifi/tls-psk").digest("hex"),
  });
  assert.equal(d.setup_example.id, "color-bands");
  const manifestUrl = new URL(d.setup_manifest);
  assert.ok(manifestUrl.searchParams.has("tag"));
  const manifest = await (await fetch(base + "/backend" + manifestUrl.pathname + manifestUrl.search)).json();
  assert.deepEqual(d.setup_example, manifest.example);
  assert.ok(d.setup_example.build_command.includes(d.board));
  assert.deepEqual(Object.keys(d.sources).sort(), ["bootloader", "sdk"]);
  const offline = await op("devices_get", id, read);
  assert.equal(offline.online, false);
  assert.equal(offline.kind, "physical");
  assert.deepEqual(offline.sources, d.sources);
  const watch = await op("devices_create", {
    board: "m5stack/stopwatch",
    name: "Watch",
  });
  assert.equal(watch.setup_example.id, "bar-graph");
  assert.ok(watch.examples.some(e => e.id === "buttons"));
  assert.match(watch.ble_secret, /^[0-9a-f]{64}$/);
  assert.match(watch.prompt, /Bootloader mode for the BLE connection/);
  const local = (url) => base + "/backend" + new URL(url).pathname;
  const localFiles = {};
  const imageSizes = { app: 4 * 1024 * 1024 + 1, bootloader: 200000 };
  for (const kind of ["bootloader", "app"]) {
    const file = Buffer.alloc(imageSizes[kind], 0xe9);
    const grant = await op("ota_prepare_upload", {
      ...id,
      kind,
      size: file.length,
    });
    const upload = (body, headers) =>
      fetch(local(grant.upload_url), { method: "PUT", headers, body });
    assert.equal((await upload(file, {})).status, 403);
    const wrongLength = await upload(file.subarray(1), grant.headers);
    assert.equal(wrongLength.status, 400, `${kind}: ${await wrongLength.text()}`);
    const response = await upload(file, grant.headers);
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).url, grant.url);
    assert.equal(
      (await upload(Buffer.alloc(file.length, 1), grant.headers)).status,
      409,
    );
    const get = (token) =>
      fetch(local(grant.url), {
        headers: {
          Authorization: "Bearer " + token,
          "Accept-Encoding": "identity",
        },
      });
    assert.equal((await get(watch.token)).status, 404);
    assert.equal((await fetch(local(grant.url))).status, 401);
    const downloaded = await get(d.token);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("Content-Length"), String(file.length));
    assert.ok(Buffer.from(await downloaded.arrayBuffer()).equals(file));
    localFiles[kind] = grant.url;
  }
  const pending = await op("ota_prepare_upload", {
    ...id,
    kind: "bootloader",
    size: 100,
  });

  const other = await issue("devices:read devices:write", {
    sub: otherSubject,
  });
  await assert.rejects(op("devices_bind_ble_address", bindArgs, other), /not found/i);
  for (const name of ["devices_get", "devices_delete", "wifi_ble_credential"]) {
    const response = await request(
      "tools/call",
      { name, arguments: id },
      other,
    );
    const result = (await message(response)).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not found/i);
  }
  assert.equal((await request("tools/list", {}, d.token)).status, 401);
  mcu = simulatedDevice(base, d.token);
  const addresses = { ble_address: reportedAddress, net_mac: "00:11:22:33:44:54" };
  const boot = await mcu.hello({
    ...addresses,
    role: "bootloader",
    bootloader_version: "1.2.3",
  });
  const connected = await op("devices_get", id);
  assert.equal(connected.online, true);
  assert.equal(connected.board, d.board);
  assert.deepEqual(connected.info, { role: "bootloader", net_mac: addresses.net_mac });
  assert.equal((await op("devices_list", {}, read))[0].ble_address, reportedAddress.toLowerCase());
  const ingress = (auth, principal, frame) =>
    fetch(base + "/backend/internal/iot/uplink", {
      method: "POST",
      headers: {
        authorization: "Bearer " + auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device: d.id,
        principal,
        frame: { boot_id: boot, mid: 1, ...frame },
      }),
    });
  assert.equal(
    (await ingress(d.token, mcu.principal, { t: "hello" })).status,
    401,
  );
  assert.equal(
    (
      await ingress(process.env.TEST_RELAY_SECRET, "1".repeat(64), {
        t: "hello",
      })
    ).status,
    409,
  );
  assert.deepEqual(await op("wifi_ble_credential", id), firstBle);

  const result = (idValue) =>
    op("commands_get", { ...id, command_id: idValue }, read);
  await assert.rejects(op("logs_read", id, other), /not found/i);
  assert.equal((await op("logs_read", id, read)).last, 0);
  const toggled = await op("logs_set", { ...id, enabled: true });
  const toggle = await mcu.nextCommand();
  assert.equal(toggle.op, "logs.set");
  assert.deepEqual(toggle.args, { enabled: true });
  await mcu.send({ t: "res", id: toggle.id, ok: true, data: { enabled: true } });
  assert.deepEqual((await result(toggled.command_id)).result, toggle.args);
  const text = "C: 42\n打印 🎉\n";
  const log = { t: "log", bytes: Buffer.from(text).toString("base64"), dropped: 17 };
  await mcu.sendBestEffort(log);
  // The simulated device sends no application ACK request for QoS 0. Wait for
  // the relay/Worker commit before disconnecting and checking offline reads.
  for (let i = 0; i < 100; i++) {
    if ((await op("logs_read", id, read)).last) break;
    await delay(20);
  }
  const wifi = {
    ...id,
    ssid: "field network",
    password: "fixture passphrase",
    request_id: randomUUID(),
  };
  await mcu.disconnect();
  const page = await op("logs_read", { ...id, process_id: boot, limit: 1 }, read);
  assert.equal(page.process_id, boot);
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].text, text);
  assert.equal(page.records[0].dropped_bytes, 17);
  // The AWS relay may redeliver an already committed frame.
  assert.equal((await ingress(process.env.TEST_RELAY_SECRET, mcu.principal, {
    ...log, mid: page.records[0].mid,
  })).status, 200);
  assert.equal((await ingress(process.env.TEST_RELAY_SECRET, mcu.principal, {
    ...log, bytes: "!".repeat(512),
  })).status, 400);
  assert.deepEqual((await op("logs_read", { ...id, process_id: boot, after: page.cursor }, read)).records, []);
  assert.equal((await op("devices_get", id)).online, false);
  await mcu.subscribe(); // New broker session, before this boot has introduced itself.
  assert.equal((await op("devices_get", id)).online, false);
  await assert.rejects(
    op("devices_send", { ...id, payload: "offline" }),
    /offline/i,
  );
  await mcu.reconnect();
  const payload = { text: "Hello", flags: [true, null] };
  const { message_id } = await op("devices_send", { ...id, payload });
  assert.deepEqual(await mcu.nextMessage(), { id: message_id, payload });
  await mcu.sendBestEffort({
    t: "message",
    payload: [23.4],
    reply_to: message_id,
  });
  let reply;
  for (let i = 0; i < 100 && !reply; i++) {
    const pageAfter = await op(
      "logs_read",
      { ...id, after: page.cursor },
      read,
    );
    reply = pageAfter.records.find((entry) => entry.type === "message");
    if (!reply) await delay(20);
  }
  assert.deepEqual(reply?.payload, [23.4]);
  assert.equal(reply?.reply_to, message_id);
  await mcu.disconnect();
  const added = await op("wifi_add", wifi);
  assert.equal((await result(added.command_id)).state, "queued");
  await mcu.reconnect();
  assert.equal((await op("wifi_add", wifi)).command_id, added.command_id);
  const save = await mcu.nextCommand();
  assert.ok(Number.isSafeInteger(save.seq));
  assert.deepEqual(save.args, {
    name: "wifi",
    argv: ["add", wifi.ssid, wifi.password],
  });
  assert.equal(mcu.queued, 0);
  await mcu.reconnect();
  assert.deepEqual(await mcu.nextCommand(), save); // Same delivery after a lost publication.
  assert.equal((await result(save.id)).state, "dispatched");
  const ack = {
    t: "res",
    id: save.id,
    ok: true,
    data: { output: "Saved network" },
  };
  await mcu.send(ack);
  await mcu.send(ack);
  assert.deepEqual((await result(save.id)).result, ack.data);
  const stored =
    await sql`SELECT args,result FROM esphub.device_commands WHERE id=${save.id}`;
  assert.ok(!JSON.stringify(stored).includes(wifi.password));
  await mcu.send({ t: "event", name: "draw.done", data: { rotation: 1 } });

  assert.equal((await op("bootloader_enter", id)).mode, "bootloader");
  for (const url of [localFiles.app, pending.url]) {
    await assert.rejects(op("ota_install", { ...id, kind: "bootloader", url }), /Upload not ready/);
  }
  for (const [kind, url] of Object.entries(localFiles)) {
    const key = randomUUID();
    const queued = await op("ota_install", { ...id, kind, url, request_id: key });
    const cmd = await mcu.nextCommand();
    assert.equal(cmd.id, queued.command_id);
    assert.deepEqual(cmd.args, { url, kind, transfer_id: key, image_size: imageSizes[kind] });
    const ok = kind === "app";
    await mcu.send({ t: "event", name: ok ? "install.done" : "install.failed",
      data: { transfer_id: key, kind } });
    assert.equal((await result(cmd.id)).state, ok ? "succeeded" : "failed");
  }

  const reboot = await op("devices_reboot", id);
  assert.equal((await mcu.nextCommand()).id, reboot.command_id);
  const app = await mcu.hello({
    ...addresses,
    role: "app",
    fw: { name: "color-bands", version: "2.0.4" },
    sdk_version: "8.0.0",
  });
  assert.equal((await result(reboot.command_id)).state, "succeeded");
  const currentApp = await op("devices_get", id);
  assert.equal(currentApp.board, d.board);
  assert.deepEqual(currentApp.info, { role: "app", net_mac: addresses.net_mac });
  assert.equal(currentApp.ble_address, reportedAddress.toLowerCase());
  const inventory = currentApp.software;
  assert.equal(inventory.bootloader_version, "1.2.3");
  assert.deepEqual(inventory.application, { name: "color-bands", version: "2.0.4", sdk_version: "8.0.0", last_seen: false });
  const firmware = await op("firmware_get", id, read);
  assert.deepEqual(firmware.software, inventory);
  assert.deepEqual(firmware.examples, currentApp.examples);
  const status = await mcu.nextCommand();
  assert.equal(status.id, firmware.command_id);
  assert.equal(status.op, "status");
  await mcu.send({ t: "res", id: status.id, ok: true, data: { fw: inventory.application } });
  assert.equal(
    (
      await ingress(process.env.TEST_RELAY_SECRET, mcu.principal, {
        boot_id: boot,
        ble_address: usbAddress,
        t: "hello",
        role: "bootloader",
      })
    ).status,
    409,
  );
  assert.equal((await op("devices_get", id)).ble_address, reportedAddress.toLowerCase());
  await assert.rejects(
    op("ota_install", { ...id, kind: "app" }),
    /bootloader/i,
  );
  assert.deepEqual(mcu.httpsRequests, ["iot/enroll"]);
  // A request dispatched in the bootloader is completed by a different boot.
  const installBootloader = { ...id, kind: "bootloader", url: localFiles.bootloader };
  await assert.rejects(op("ota_install", installBootloader), /bootloader/i);
  await mcu.hello({ role: "bootloader" });
  const handoff = await op("ota_install", installBootloader);
  const firstAttempt = await mcu.nextCommand();
  assert.equal(firstAttempt.id, handoff.command_id);
  await mcu.hello({ role: "app", fw: { name: "sample", version: "2.0.4" } });
  await mcu.send({ t: "event", name: "install.failed",
    data: { transfer_id: firstAttempt.args.transfer_id, error: "HTTPS read failed" } });
  assert.equal((await result(firstAttempt.id)).state, "failed");
  await assert.rejects(op("ota_install", installBootloader), /bootloader/i);
  await mcu.hello({ role: "bootloader" });
  const retry = await op("ota_install", installBootloader);
  const nextAttempt = await mcu.nextCommand();
  assert.equal(nextAttempt.id, retry.command_id);
  await mcu.send({ t: "event", name: "install.done",
    data: { transfer_id: nextAttempt.args.transfer_id, kind: "bootloader" } });
  assert.equal((await result(nextAttempt.id)).state, "succeeded");
  const exit = await op("bootloader_exit", id);
  const exitCommand = await mcu.nextCommand();
  assert.equal(exitCommand.id, exit.command_id);
  assert.deepEqual(exitCommand.args, { target: "app" });
  await mcu.hello({ role: "app", fw: { name: "sample", version: "2.0.4" } });
  assert.equal((await result(exit.command_id)).state, "succeeded");
  await assert.rejects(op("bootloader_exit", id), /bootloader mode/);
  const originalLayout = { app_size_bytes: 0x400000, data_size_bytes: 0x160000 };
  const largerLayout = { app_size_bytes: 0x500000, data_size_bytes: 0x60000 };
  const grow = { ...id, app_size_bytes: largerLayout.app_size_bytes, erase_littlefs: true, request_id: randomUUID() };
  await assert.rejects(op("ota_resize_app", grow), /bootloader/i);
  await mcu.hello({ role: "bootloader" });
  await assert.rejects(op("ota_resize_app", grow), /layout unavailable/i);
  await mcu.send({ t: "event", name: "ota.layout", data: originalLayout });
  assert.deepEqual((await op("devices_get", id)).info.layout, originalLayout);
  await assert.rejects(op("ota_resize_app", { ...grow, erase_littlefs: false }), /erases LittleFS/);
  await assert.rejects(op("ota_resize_app", { ...grow, app_size_bytes: 0x600000 }), /exceeds available/);

  const growRequest = await op("ota_resize_app", grow);
  const resize = await mcu.nextCommand();
  assert.equal(resize.id, growRequest.command_id);
  assert.equal(resize.op, "resize_app");
  assert.equal(resize.args.data_size_bytes, largerLayout.data_size_bytes);
  assert.equal(resize.args.transfer_id, grow.request_id);
  await mcu.send({ t: "res", id: resize.id, ok: true, data: { ...largerLayout, rebooting: true } });
  assert.equal((await result(resize.id)).state, "dispatched");
  await mcu.send({ t: "event", name: "install.done", data: { ...largerLayout, kind: "resize_app", transfer_id: grow.request_id } });
  assert.equal((await result(resize.id)).state, "dispatched");
  assert.deepEqual((await op("devices_get", id)).info.layout, originalLayout);
  await mcu.hello({ role: "bootloader" });
  const confirmed = { ...largerLayout, kind: "resize_app", transfer_id: grow.request_id };
  await mcu.send({ t: "event", name: "install.done", data: confirmed });
  assert.deepEqual((await result(resize.id)).result, confirmed);
  assert.equal((await result(resize.id)).state, "succeeded");
  assert.deepEqual((await op("devices_get", id)).info.layout, largerLayout);
  assert.equal((await op("ota_resize_app", grow)).command_id, resize.id);

  await op("ota_resize_app", { ...id, app_size_bytes: largerLayout.app_size_bytes });
  const same = await mcu.nextCommand();
  assert.equal(same.args.erase_littlefs, false);
  await mcu.send({ t: "res", id: same.id, ok: true, data: { ...largerLayout, unchanged: true } });
  assert.equal((await result(same.id)).state, "succeeded");
  await op("ota_resize_app", { ...id, app_size_bytes: originalLayout.app_size_bytes, erase_littlefs: true });
  const shrink = await mcu.nextCommand();
  assert.equal(shrink.args.data_size_bytes, originalLayout.data_size_bytes);
  await mcu.send({ t: "res", id: shrink.id, ok: false, error: "Installed app exceeds target" });
  assert.equal((await result(shrink.id)).state, "failed");
  assert.deepEqual((await op("devices_get", id)).info.layout, largerLayout);
  await assert.rejects(op("ota_install", { ...id, kind: "app", url: "https://firmware.example/test.bin",
    image_size_bytes: 5242881 }), /Image 5242881 bytes, app slot 5242880, maximum after resize 5570560/);
  // A third-party stream without a known length still reports usable device bounds.
  await op("ota_install", { ...id, kind: "app", url: "https://firmware.example/test.bin" });
  const streamed = await mcu.nextCommand();
  await mcu.send({ t: "event", name: "install.failed", data: {
    kind: "app", transfer_id: streamed.args.transfer_id, error: "Download exceeds target size",
  } });
  const tooLarge = await result(streamed.id);
  assert.equal(tooLarge.result.app_size_bytes, largerLayout.app_size_bytes);
  assert.equal(tooLarge.result.max_app_size_bytes, 0x550000);
  assert.equal(tooLarge.result.image_size_at_least, largerLayout.app_size_bytes + 1);

  await op("ota_resize_app", { ...id, app_size_bytes: originalLayout.app_size_bytes, erase_littlefs: true });
  const mismatch = await mcu.nextCommand();
  await mcu.hello({ role: "bootloader" });
  await mcu.send({ t: "event", name: "install.done", data: {
    ...largerLayout, kind: "resize_app", transfer_id: mismatch.args.transfer_id,
  } });
  assert.equal((await result(mismatch.id)).state, "failed");
  assert.match((await result(mismatch.id)).result.error, /does not match/);
  await op("devices_reissue", id);
  assert.equal(
    (
      await ingress(process.env.TEST_RELAY_SECRET, mcu.principal, {
        boot_id: app,
        t: "event", name: "draw.done",
      })
    ).status,
    409,
  );
  await op("devices_delete", { device_id: watch.id });
  await op("devices_delete", id);
  console.log(
    "PASS Clerk, virtual devices, broker enrollment, command dispatch, duplicate receipts, cloud Wi-Fi, BLE credentials, MQTT events, OTA, private file transfer and revocation",
  );
} finally {
  mcu?.close();
  await sql`DELETE FROM esphub.accounts WHERE clerk_subject IN (${subject}, ${otherSubject})`;
  await sql.end();
}
