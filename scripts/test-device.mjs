import assert from "node:assert/strict";
import postgres from "postgres";
import { simulatedDevice } from "../tests/fixtures/iot/device.mjs";
import { importPKCS8, SignJWT } from "jose";
import { createHash, createHmac, randomUUID } from "node:crypto";
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
  const createVirtual = () => op("devices.create_virtual", {});
  const [virtual, duplicate] = await Promise.all([
    createVirtual(),
    createVirtual(),
  ]);
  assert.deepEqual(virtual, duplicate);
  assert.equal(virtual.kind, "virtual");
  const vid = { device_id: virtual.id };
  const firmware = await op("firmware.get", vid, read);
  const [listedVirtual] = await op("devices.list", {}, read);
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
    op("devices.reboot", rebootArgs),
    op("devices.reboot", rebootArgs),
  ]);
  assert.deepEqual(retry, restart);
  assert.notEqual(restart.process_id, firmware.process_id);
  const later = await op("devices.reboot", vid);
  assert.deepEqual(await createVirtual(), virtual);
  assert.deepEqual(await op("devices.reboot", rebootArgs), restart);
  const reconnected = await issue("devices:read");
  const current = await op("devices.get", vid, reconnected);
  assert.equal(current.process_id, later.process_id);
  const secondAccount = await issue("devices:read devices:write", {
    sub: otherSubject,
  });
  assert.deepEqual(await op("devices.list", {}, secondAccount), []);
  const secondBoard = await op("devices.create_virtual", {}, secondAccount);
  assert.notEqual(secondBoard.id, virtual.id);
  for (const name of [
    "devices.get",
    "devices.reboot",
    "devices.delete",
    "programs.publish",
  ]) {
    const args = name === "programs.publish" ? { ...vid, source: "pass" } : vid;
    const result = await call(
      "tools/call",
      { name, arguments: args },
      secondAccount,
    );
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /Device not found/, name);
  }
  const staged = await op("programs.publish", {
    ...vid,
    source: 'print("staged")',
  });
  assert.equal(staged.status, "staged");
  assert.equal(staged.executable, false);
  assert.match(
    staged.url,
    /^https:\/\/api\.esphub\.ai\/api\/device\/programs\//,
  );
  for (const [name, args] of [
    ["devices.bind_ble_address", { ...vid, ble_address: "02:11:22:33:44:55" }],
    ["wifi.scan", vid],
    ["wifi.ble_credential", vid],
    ["devices.reissue", vid],
    ["bootloader.enter", vid],
    ["bootloader.exit", vid],
    ["ota.install", { ...vid, kind: "python", url: staged.url }],
  ]) {
    const result = await call("tools/call", { name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /requires a physical device/, name);
  }
  await op("devices.delete", vid);
  assert.deepEqual(await op("devices.list", {}, read), []);
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
    { name: "devices.list", arguments: {} },
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
    { name: "devices.list", arguments: {} },
    read,
  );
  assert.equal(list.status, 200);
  assert.deepEqual(
    JSON.parse((await message(list)).result.content[0].text),
    [],
  );
  const listed = (await call("tools/list", {})).tools;
  assert.deepEqual((await call("tools/list", {}, null)).tools, listed);
  const readOnly = new Set([
    "commands.get",
    "devices.list",
    "devices.get",
    "wifi.list",
    "firmware.get",
    "programs.get",
  ]);
  const additiveTools = new Set([
    "wifi.ble_credential",
    "devices.create",
    "devices.create_virtual",
    "ota.prepare_upload",
    "programs.publish",
  ]);
  const openWorldTools = new Set([
    "wifi.scan",
    "wifi.add",
    "ota.install",
  ]);
  for (const { name, annotations } of listed) {
    // Active Wi-Fi discovery observes nearby networks but still requires write scope.
    const observesOnly = readOnly.has(name) || name === "wifi.scan";
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
  const apiDenied = await fetch(base + "/backend/auth/me", {
    headers: { Authorization: "Bearer " + key },
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
  const d = await op("devices.create", {
      board: "paper-color",
      name: "Simulator",
    }),
    id = { device_id: d.id };
  assert.match(d.prompt, /hidden SSID/);
  assert.match(d.ble_secret, /^[0-9a-f]{64}$/);
  const usbAddress = "02:AA:BB:CC:DD:EE";
  const reportedAddress = "02:11:22:AA:BB:CC";
  const bindArgs = { ...id, ble_address: usbAddress };
  assert.equal((await op("devices.get", id)).ble_address, null);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await op("devices.bind_ble_address", bindArgs), {
      id: d.id, ble_address: usbAddress.toLowerCase(),
    });
  }
  await assert.rejects(op("devices.bind_ble_address", { ...id, ble_address: "wrong" }), /Invalid ble_address/);
  assert.equal((await op("devices.list", {}, read))[0].ble_address, usbAddress.toLowerCase());
  const firstBle = await op("wifi.ble_credential", id);
  assert.deepEqual(firstBle, {
    psk: createHmac("sha256", Buffer.from(d.ble_secret, "hex"))
      .update("esphub/wifi/tls-psk").digest("hex"),
  });
  assert.match(d.verification_source, /Hello, M5Stack Paper Color/);
  assert.equal(
    d.setup_manifest,
    "https://api.esphub.ai/releases/paper-color/setup-manifest",
  );
  assert.deepEqual(Object.keys(d.sources).sort(), [
    "bootloader",
    "micropython",
    "python",
  ]);
  const offline = await op("devices.get", id, read);
  assert.equal(offline.online, false);
  assert.equal(offline.kind, "physical");
  assert.deepEqual(offline.sources, d.sources);
  const watch = await op("devices.create", {
    board: "stopwatch",
    name: "Watch",
  });
  assert.match(watch.verification_source, /Hello, M5Stack Stopwatch/);
  assert.match(watch.verification_source, /setBrightness/);
  assert.match(watch.ble_secret, /^[0-9a-f]{64}$/);
  assert.match(watch.prompt, /Bootloader mode for the BLE connection/);
  const local = (url) => base + "/backend" + new URL(url).pathname;
  const localFiles = {};
  for (const kind of ["bootloader", "micropython", "native"]) {
    const file = Buffer.alloc(200000, 0xe9);
    const grant = await op("ota.prepare_upload", {
      ...id,
      kind,
      size: file.length,
    });
    const upload = (body, headers) =>
      fetch(local(grant.upload_url), { method: "PUT", headers, body });
    assert.equal((await upload(file, {})).status, 403);
    assert.equal((await upload(file.subarray(1), grant.headers)).status, 400);
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
  const pending = await op("ota.prepare_upload", {
    ...id,
    kind: "bootloader",
    size: 100,
  });

  const other = await issue("devices:read devices:write", {
    sub: otherSubject,
  });
  await assert.rejects(op("devices.bind_ble_address", bindArgs, other), /not found/i);
  for (const name of ["devices.get", "devices.delete", "wifi.ble_credential"]) {
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
  const boot = await mcu.hello({
    board: d.board,
    role: "bootloader",
    chip: "esp32s3",
    ble_address: reportedAddress,
    mac: "00:11:22:33:44:55",
    dual_bootloader_ota: true,
    image_profile: "ESPHUB2/bootloader/esp32s3-16mb",
    fw: { version: "1.2.3" },
  });
  assert.equal((await op("devices.get", id)).online, true);
  assert.equal((await op("devices.list", {}, read))[0].ble_address, reportedAddress.toLowerCase());
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
  assert.deepEqual(await op("wifi.ble_credential", id), firstBle);

  const result = (idValue) =>
    op("commands.get", { ...id, command_id: idValue }, read);
  const wifi = {
    ...id,
    ssid: "field network",
    password: "fixture passphrase",
    request_id: randomUUID(),
  };
  await mcu.disconnect();
  assert.equal((await op("devices.get", id)).online, false);
  await mcu.subscribe(); // New broker session, before this boot has introduced itself.
  assert.equal((await op("devices.get", id)).online, false);
  const added = await op("wifi.add", wifi);
  assert.equal((await result(added.command_id)).state, "queued");
  await mcu.reconnect();
  assert.equal((await op("wifi.add", wifi)).command_id, added.command_id);
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

  const source = 'print("café")';
  const staged = await op("programs.publish", { ...id, source });
  assert.equal((await fetch(local(staged.url))).status, 401);
  assert.equal(
    (
      await fetch(local(staged.url), {
        headers: { authorization: "Bearer " + watch.token },
      })
    ).status,
    404,
  );
  assert.equal(
    await (
      await fetch(local(staged.url), {
        headers: { authorization: "Bearer " + d.token },
      })
    ).text(),
    source,
  );
  assert.equal((await op("bootloader.enter", id)).mode, "bootloader");
  for (const url of [staged.url, pending.url]) {
    await assert.rejects(
      op("ota.install", { ...id, kind: "bootloader", url }),
      /Upload not ready/,
    );
  }
  let pythonInstall;
  const sha256 = createHash("sha256").update(source).digest("hex");
  for (const [kind, url] of [
    ["python", staged.url],
    ["bootloader", localFiles.bootloader],
    ["micropython", localFiles.micropython],
    ["native", localFiles.native],
  ]) {
    const key = randomUUID(),
      queued = await op("ota.install", { ...id, kind, url, request_id: key });
    const cmd = await mcu.nextCommand();
    assert.equal(cmd.id, queued.command_id);
    assert.deepEqual(cmd.args, { url, board: d.board, kind, transfer_id: key });
    const ok = kind !== "bootloader";
    if (kind === "python") pythonInstall = key;
    await mcu.send({
      t: "event",
      name: ok ? "install.done" : "install.failed",
      data: { transfer_id: key, kind, ...(kind === "python" ? {sha256, bytes:Buffer.byteLength(source)} : {}) },
    });
    assert.equal((await result(cmd.id)).state, ok ? "succeeded" : "failed");
  }

  const reboot = await op("devices.reboot", id);
  assert.equal((await mcu.nextCommand()).id, reboot.command_id);
  const app = await mcu.hello({
    board: d.board,
    role: "app",
    mac: "00:11:22:33:44:55",
    image_profile: "ESPHUB2/micropython/" + d.board,
    fw: { name: "micropython", version: "test" },
  });
  assert.equal((await result(reboot.command_id)).state, "succeeded");
  const legacy = await op("devices.get", id);
  assert.equal(legacy.ble_address, reportedAddress.toLowerCase());
  const inventory = legacy.software;
  assert.equal(inventory.bootloader_version, "1.2.3");
  assert.equal(inventory.application.kind, "micropython");
  assert.equal(
    (
      await ingress(process.env.TEST_RELAY_SECRET, mcu.principal, {
        boot_id: boot,
        ble_address: usbAddress,
        t: "hello",
        board: d.board,
        role: "bootloader",
      })
    ).status,
    409,
  );
  assert.equal((await op("devices.get", id)).ble_address, reportedAddress.toLowerCase());
  await assert.rejects(
    op("ota.install", { ...id, kind: "python", url: staged.url }),
    /bootloader/i,
  );
  assert.deepEqual(await op("programs.get", id), {
    status:"installed", transfer_id:pythonInstall, sha256, bytes:Buffer.byteLength(source)
  });
  assert.deepEqual(mcu.httpsRequests, ["iot/enroll"]);
  // A request dispatched in the bootloader is completed by a different boot.
  const installBootloader = { ...id, kind: "bootloader", url: localFiles.bootloader };
  await assert.rejects(op("ota.install", installBootloader), /bootloader/i);
  const info = { board: d.board, chip: "esp32s3", dual_bootloader_ota: true, bootloader_profile: "esp32s3-16mb" };
  await mcu.hello({ ...info, role: "bootloader", image_profile: "ESPHUB2/bootloader/esp32s3-16mb" });
  const handoff = await op("ota.install", installBootloader);
  const firstAttempt = await mcu.nextCommand();
  assert.equal(firstAttempt.id, handoff.command_id);
  await mcu.hello({ ...info, role: "app", image_profile: "ESPHUB2/micropython/" + d.board });
  await mcu.send({ t: "event", name: "install.failed",
    data: { transfer_id: firstAttempt.args.transfer_id, error: "HTTPS read failed" } });
  assert.equal((await result(firstAttempt.id)).state, "failed");
  await assert.rejects(op("ota.install", installBootloader), /bootloader/i);
  await mcu.hello({ ...info, role: "bootloader", image_profile: "ESPHUB2/bootloader/esp32s3-16mb" });
  const retry = await op("ota.install", installBootloader);
  const nextAttempt = await mcu.nextCommand();
  assert.equal(nextAttempt.id, retry.command_id);
  await mcu.send({ t: "event", name: "install.done",
    data: { transfer_id: nextAttempt.args.transfer_id, kind: "bootloader" } });
  assert.equal((await result(nextAttempt.id)).state, "succeeded");
  const exit = await op("bootloader.exit", id);
  const exitCommand = await mcu.nextCommand();
  assert.equal(exitCommand.id, exit.command_id);
  assert.deepEqual(exitCommand.args, { target: "app" });
  await mcu.hello({ ...info, role: "app", image_profile: "ESPHUB2/micropython/" + d.board });
  assert.equal((await result(exit.command_id)).state, "succeeded");
  await assert.rejects(op("bootloader.exit", id), /bootloader mode/);
  await op("devices.reissue", id);
  assert.equal(
    (
      await ingress(process.env.TEST_RELAY_SECRET, mcu.principal, {
        boot_id: app,
        t: "event", name: "draw.done",
      })
    ).status,
    409,
  );
  await op("devices.delete", { device_id: watch.id });
  await op("devices.delete", id);
  console.log(
    "PASS Clerk, virtual devices, broker enrollment, command dispatch, duplicate receipts, cloud Wi-Fi, BLE credentials, MQTT events, OTA, private file transfer and revocation",
  );
} finally {
  mcu?.close();
  await sql`DELETE FROM esphub.accounts WHERE clerk_subject IN (${subject}, ${otherSubject})`;
  await sql.end();
}
