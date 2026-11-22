import assert from "node:assert/strict";
import postgres from "postgres";
import WebSocket from "ws";
import { importPKCS8, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
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
  assert.equal(listedVirtual.serial_input, false);
  assert.deepEqual(
    (
      await sql`SELECT token_hash,ble_secret,cert_id,transport FROM esphub.devices WHERE id=${virtual.id}`
    )[0],
    { token_hash: null, ble_secret: null, cert_id: null, transport: null },
  );
  assert.equal((await op("uart.sessions", vid, read)).length, 1);
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
  const history = await op("uart.sessions", vid, reconnected);
  assert.deepEqual(
    history.map((s) => s.process_id),
    [later.process_id, restart.process_id, firmware.process_id],
  );
  const logArgs = { ...vid, process_id: restart.process_id };
  const output = await op("uart.read", logArgs, read);
  assert.match(output.records[0].text, /Virtual ESP32 restarted/);
  assert.deepEqual(
    output.records.map((r) => r.seq),
    [1, 2],
  );
  assert.deepEqual(
    (await op("uart.read", { ...logArgs, after: 1 }, read)).records,
    output.records.slice(1),
  );
  assert.deepEqual(await op("uart.read", { ...logArgs, after: 2 }, read), {
    records: [],
    cursor: 2,
    last: 2,
  });
  assert.match(
    (await op("uart.read", { ...vid, process_id: firmware.process_id }, read))
      .records[0].text,
    /created/,
  );

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
    "uart.sessions",
    "uart.read",
    "programs.publish",
  ]) {
    const args =
      name === "uart.read"
        ? logArgs
        : name === "programs.publish"
          ? { ...vid, source: "pass" }
          : vid;
    const result = await call(
      "tools/call",
      { name, arguments: args },
      secondAccount,
    );
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /Device not found/, name);
  }
  const wrongBoot = await call(
    "tools/call",
    {
      name: "uart.read",
      arguments: {
        device_id: secondBoard.id,
        process_id: restart.process_id,
      },
    },
    secondAccount,
  );
  assert.match(wrongBoot.content[0].text, /Unknown boot session/);
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
    ["wifi.scan", vid],
    ["wifi.ble_credential", vid],
    ["devices.reissue", vid],
    ["launcher.enter", vid],
    ["launcher.install", vid],
    ["ota.install", { ...vid, kind: "python", url: staged.url }],
    ["uart.write", { ...logArgs, text: "help", request_id: randomUUID() }],
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

let ws;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  for (const invalid of [
    null,
    "esh_key_retired",
    await issue("devices:read", { aud: "https://another.example/mcp" }),
    await issue("devices:read", { aud: undefined }),
    await issue("devices:read", { exp: 1 }),
    await issue("devices:read", { sid: "sess_fixture" }, "JWT"),
  ]) {
    const denied = await request("tools/list", {}, invalid);
    assert.equal(denied.status, 401);
    if (invalid === null)
      assert.match(
        denied.headers.get("WWW-Authenticate"),
        /scope="devices:read devices:write offline_access"/,
      );
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
  assert.equal(listed.length, 25);
  assert.ok(!listed.some(t => t.name === "programs.install"));
  const readOnly = new Set([
    "commands.get",
    "devices.list",
    "devices.get",
    "wifi.list",
    "firmware.get",
    "programs.get",
    "uart.sessions",
    "uart.read",
  ]);
  const additiveTools = new Set(["logs.flush", "wifi.ble_credential", "devices.create", "devices.create_virtual", "ota.prepare_upload", "programs.publish"]);
  const openWorldTools = new Set(["wifi.scan", "wifi.add", "launcher.install", "ota.install", "uart.write"]);
  for (const { name, annotations } of listed) {
    // Active Wi-Fi discovery observes nearby networks but still requires write scope.
    const observesOnly = readOnly.has(name) || name === "wifi.scan";
    assert.equal(annotations?.readOnlyHint, observesOnly, name);
    assert.equal(annotations?.destructiveHint, !observesOnly && !additiveTools.has(name), name);
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
  const retired = await fetch(base + "/backend/auth/key", {
    method: "POST",
    headers: { Origin: base },
  });
  assert.equal(retired.status, 404);
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
  assert.ok(
    (await call("tools/list", {})).tools.some((t) => t.name === "uart.write"),
  );
  await testVirtualDevice(read);
  const d = await op("devices.create", {
      board: "paper-color",
      name: "Simulator",
    }),
    id = { device_id: d.id };
  assert.match(d.prompt, /hidden SSID/);
  assert.match(d.ble_secret, /^[0-9a-f]{64}$/);
  const firstBle = await op("wifi.ble_credential", id);
  const { credential } = await import("../services/api/src/ble.js");
  const deriveFor = (secret, beacon) => credential(secret, Buffer.from(beacon.slice(0,16), "hex"));
  assert.deepEqual(firstBle, await deriveFor(d.ble_secret, firstBle.beacon));
  assert.match(d.verification_source, /Hello, M5Stack Paper Color/);
  assert.equal(
    d.setup_manifest,
    "https://api.esphub.ai/releases/paper-color/setup-manifest",
  );
  assert.deepEqual(Object.keys(d.sources).sort(), ["launcher", "micropython", "python"]);
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

  const local = url => base + "/backend" + new URL(url).pathname;
  const localFiles = {};
  for (const kind of ["python", "launcher", "micropython"]) {
    const file = kind === "python" ? Buffer.from("print('R2')") : Buffer.alloc(200000, 0xe9);
    const grant = await op("ota.prepare_upload", { ...id, kind, size: file.length });
    const upload = (body, headers) => fetch(local(grant.upload_url), { method: "PUT", headers, body });
    assert.equal((await upload(file, {})).status, 403);
    assert.equal((await upload(file.subarray(1), grant.headers)).status, 400);
    const response = await upload(file, grant.headers);
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).url, grant.url);
    assert.equal((await upload(Buffer.alloc(file.length, 1), grant.headers)).status, 409);
    const get = token => fetch(local(grant.url), { headers: { Authorization: "Bearer " + token, "Accept-Encoding": "identity" } });
    assert.equal((await get(watch.token)).status, 404);
    assert.equal((await fetch(local(grant.url))).status, 401);
    const downloaded = await get(d.token);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("Content-Length"), String(file.length));
    assert.ok(Buffer.from(await downloaded.arrayBuffer()).equals(file));
    localFiles[kind] = grant.url;
  }
  const pending = await op("ota.prepare_upload", { ...id, kind: "launcher", size: 100 });

  const other = await issue("devices:read devices:write", {
    sub: otherSubject,
  });
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
  const socketURL = new URL("/backend/api/device/connect", base);
  socketURL.protocol = "ws:";
  ws = new WebSocket(socketURL, {
    headers: { Authorization: "Bearer " + d.token },
  });
  await new Promise((ok, no) => {
    ws.once("open", ok);
    ws.once("error", no);
  });
  const inbox = [];

  ws.on("message", (msg) => {
    const f = JSON.parse(msg.toString());
    inbox.push(f);
    if (f.t === "req") {
      assert.ok(!["py.exec", "term.write"].includes(f.op));
      const data = f.op === "install" ? { accepted: true } : { output: "test Wi-Fi network" };
      ws.send(
        JSON.stringify({
          t: "res",
          id: f.id,
          ok: true,
          data,
        }),
      );
    }
  });
  const send = (v) => ws.send(JSON.stringify(v));
  const take = async (pred) => {
    for (let i = 0; i < 150; i++) {
      const n = inbox.findIndex(pred);
      if (n >= 0) return inbox.splice(n, 1)[0];
      await sleep(75);
    }
    throw Error("WebSocket response timeout");
  };
  const session = { ...id, process_id: randomUUID() };
  send({
    t: "hello",
    boot_id: session.process_id,
    fw: { name: "launcher", version: "test" },
    role: "launcher",
    chip: "esp32s3",
  });
  await take((f) => f.t === "ack");
  send({ t: "ble.installed", generation: 1 });
  const offer = await take(f => f.t === "ble.rotate");
  assert.equal(offer.generation, 2);
  send({ t: "ble.installed", generation: 1 });
  assert.deepEqual(await take(f => f.t === "ble.rotate"), offer);
  const recovery = await op("wifi.ble_credential", id);
  const {alternate, ...previous} = recovery;
  assert.deepEqual(previous, await deriveFor(d.ble_secret, previous.beacon));
  assert.deepEqual(alternate, await deriveFor(offer.secret, alternate.beacon));
  send({ t: "ble.installed", generation: 2 });
  const afterRecovery = await take(f => f.t === "ble.rotate");
  assert.equal(afterRecovery.generation, 3);
  send({ t: "ble.installed", generation: 3 });
  send({ t: "log", seq: 1, lines: [[121, "I", "boot log"]] });
  await take((f) => f.t === "ack" && f.seq === 1);
  assert.equal(
    (await op("uart.read", { ...session, after: 0 }, read)).records[0].text,
    "boot log",
  );
  const rotatedBle = await op("wifi.ble_credential", id);
  assert.deepEqual(rotatedBle, await deriveFor(afterRecovery.secret, rotatedBle.beacon));
  assert.notEqual(rotatedBle.psk, (await deriveFor(d.ble_secret, rotatedBle.beacon)).psk);
  assert.equal((await op("devices.get", id, read)).online, true);
  const data = { ...session, text: "help\n", request_id: randomUUID() };
  assert.equal((await op("uart.write", data)).sequence, 1);
  assert.equal((await op("uart.write", data)).sequence, 1);
  send({ t: "uart.poll", after: 0 });
  assert.equal((await take((f) => f.t === "uart.input")).text, "help\n");
  send({ t: "uart.poll", after: 1 });
  send({ t: "log", seq: 2, lines: [[456, "I", "help response"]] });
  await take((f) => f.t === "ack" && f.seq === 2);
  assert.equal(
    (await op("uart.read", { ...session, after: 1 })).records[0].text,
    "help response",
  );
  assert.equal((await op("uart.sessions", id, read))[0].rx_cursor, 1);
  await op("wifi.list", id, read);
  assert.deepEqual((await op("firmware.get", id, read)).sources, d.sources);
  assert.equal((await op("wifi.scan", id)).output, "test Wi-Fi network");
  const source = d.verification_source + "# " + "é".repeat(3500) + "\n";
  const staged = await op("programs.publish", { ...id, source });
  assert.deepEqual(staged.sources, d.sources);
  const artifactUrl = base + "/backend" + new URL(staged.url).pathname;
  assert.equal((await fetch(artifactUrl)).status, 401);
  const download = token => fetch(artifactUrl, { headers: { Authorization: "Bearer " + token } });
  assert.equal((await download(watch.token)).status, 404);
  assert.equal(await (await download(d.token)).text(), source);
  const attempt = (name, args) => call("tools/call", {name, arguments: args});
  const ota = { ...id, kind: "python", url: staged.url };
  const report = async (role, image_profile, board = "paper-color") => {
    const boot_id = randomUUID();
    send({t:"hello", boot_id, role, board, mac:"00:11:22:33:44:55", chip:"esp32s3", image_profile, fw:{version:"1.2.3", name: role === "launcher" ? "esp-launcher" : "micropython"}});
    await take(f => f.t === "ack");
    return boot_id;
  };
  const oldApp = await report("app");
  assert.equal((await attempt("ota.install", ota)).isError, true);
  assert.equal((await attempt("uart.write", {...data, process_id:oldApp})).isError, true);
  assert.equal((await op("launcher.enter", id)).mode, "rebooting");
  assert.deepEqual((await take(f => f.op === "reboot")).args, {target:"launcher"});
  await report("launcher");
  assert.match((await attempt("ota.install", ota)).content[0].text, /launcher.install/);
  await report("launcher", "ESPHUB1/launcher/stopwatch", "stopwatch");
  assert.equal((await attempt("ota.install", ota)).isError, true);
  const boot = await report("launcher", "ESPHUB1/launcher/paper-color");
  const entered = await op("launcher.enter", id);
  assert.equal(entered.mode, "launcher");
  assert.deepEqual(entered.sources, d.sources);
  for (const [kind,url] of [["launcher",pending.url], ["launcher",localFiles.python]]) {
    const rejected = await attempt("ota.install", { ...id, kind, url });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Upload this device/);
  }
  for (const kind of ["python","launcher","micropython"]) {
    const url = kind === "python" ? staged.url : kind === "launcher" ? localFiles.launcher : "https://example.org/micropython.bin";
    const receipt = await op("ota.install", { ...id, kind, url });
    assert.equal(receipt.accepted, true);
    assert.deepEqual(receipt.sources, d.sources);
    assert.equal(receipt.custom_build_guide_url, d.custom_build_guide_url);
    assert.equal(receipt.process_id, boot);
    const wire = await take(f => f.op === "install");
    assert.deepEqual(wire.args, {kind, url, board:"paper-color", transfer_id:receipt.transfer_id});
    const event = kind === "launcher" ? "install.failed" : "install.done";
    send({t:"event",name:event,data:{transfer_id:receipt.transfer_id,kind}});
    send({t:"log",seq:kind === "python" ? 1 : kind === "launcher" ? 2 : 3, lines:[[123,"I","ota"]]});
    await take(f => f.t === "ack");
    const events = await op("uart.read", { ...id, process_id: boot, after: receipt.after });
    assert.ok(events.records.some(r => r.text.includes(receipt.transfer_id) && r.text.includes(event)));
  }
  const app = await report("app", "ESPHUB1/micropython/paper-color");
  const inventory = (await op("devices.get", id)).software;
  assert.equal(inventory.launcher_version, "1.2.3");
  assert.equal(inventory.launcher_last_seen, true);
  assert.equal(inventory.application.kind, "micropython");
  assert.equal((await op("programs.get", id, read)).status, "unreported");
  const uploadSource = (pid, token, source) => fetch(base + "/backend/api/device/program/" + pid, {
    method:"PUT", headers:{Authorization:"Bearer " + token, "X-Program-Status":"available"}, body:source,
  });
  assert.equal((await uploadSource(oldApp,d.token,source)).status,409);
  assert.equal((await uploadSource(app,watch.token,source)).status,409);
  assert.equal((await uploadSource(app,d.token,source)).status,200);
  assert.deepEqual(await op("programs.get", id, read), {process_id:app, status:"available", source});
  assert.equal((await op("devices.get", id)).serial_input, true);
  await op("uart.write", {...data, process_id:app,text:"application message"});
  send({t:"uart.poll",after:0});
  assert.equal((await take(f => f.t === "uart.input")).text, "application message");
  // Exercise the new firmware protocol against a real Worker and Postgres with the
  // broker offline. A missed wake is recovered by the pull following subscription.
  await sql`UPDATE esphub.devices SET cert_id=${"0".repeat(64)} WHERE id=${watch.id}`;
  const mqttBoot=randomUUID().replaceAll("-","");
  const devicePost=async(action,body,token=watch.token)=>{
    const response=await fetch(base+"/backend/api/device/iot/"+action,{
      method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body)
    });
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  await devicePost("frame",{t:"hello",board:"stopwatch",role:"app",boot_id:mqttBoot,micropython_version:"1.27.0",fw:{name:"micropython",version:"test-runtime"}});
  assert.equal((await uploadSource(mqttBoot,watch.token,"")).status,200);
  assert.equal((await op("programs.get",{device_id:watch.id},read)).source,"");
  const flushArgs = { device_id: watch.id, process_id: mqttBoot, request_id: randomUUID() };
  await assert.rejects(op("logs.flush", flushArgs), /Log recall requires/);
  await devicePost("frame", {t:"hello", board:"stopwatch", role:"app", boot_id:mqttBoot, log_flush:true});
  const flush = await op("logs.flush", flushArgs);
  assert.equal((await op("logs.flush", flushArgs)).command_id, flush.command_id);
  const flushBoot = {boot_id:mqttBoot};
  const batch = await devicePost("pull", flushBoot);
  assert.deepEqual(batch.commands.map(c => [c.id,c.op]), [[flush.command_id,"logs.flush"]]);
  assert.equal((await devicePost("start", {...flushBoot,id:flush.command_id})).start, true);
  const logAck = await devicePost("frame", {...flushBoot,t:"log",seq:1,lines:[[1,"I","buffered log"]]});
  assert.equal(logAck.seq, 1);
  const flushData = {last_acked_seq:logAck.seq,dropped_lines:2};
  await devicePost("frame", {...flushBoot,t:"res",ok:true,id:flush.command_id,data:flushData});
  const flushStatus = await op("commands.get", {device_id:watch.id,command_id:flush.command_id}, read);
  assert.equal(flushStatus.state,"succeeded");
  assert.deepEqual(flushStatus.result,flushData);
  const queued=await op("uart.write",{device_id:watch.id,process_id:mqttBoot,request_id:randomUUID(),text:"test"});
  const body={boot_id:mqttBoot};
  const {commands}=await devicePost("pull",body);
  assert.deepEqual(commands.map(c=>[c.id,c.op,c.args]),[[queued.command_id,"term.write",{data:"test"}]]);
  assert.equal((await devicePost("start",{...body,id:queued.command_id})).start,true);
  assert.equal((await devicePost("start",{...body,id:queued.command_id})).start,false);
  const result={...body,t:"res",ok:true,id:queued.command_id,data:{written:4}};
  await devicePost("frame",result);
  await devicePost("frame",result);
  const status=await op("commands.get",{device_id:watch.id,command_id:queued.command_id},read);
  assert.equal(status.state,"succeeded"); assert.deepEqual(status.result,result.data);
  await op("devices.delete", { device_id: watch.id });
  const archived = await call("tools/call", {
    name: "uart.write",
    arguments: { ...data, request_id: randomUUID() },
  });
  assert.equal(archived.isError, true);
  await op("devices.delete", id);
  console.log(
    "PASS Clerk OAuth discovery, 25 MCP tools, persistent virtual devices and idempotent reboots, BLE credential issuance and acknowledged rotation, private R2 uploads, private HTTPS program staging and all three OTA commands, scoped access and owner isolation, authenticated simulated MCU, boot isolation, RX idempotency and ACK, R2 TX replay, live RPC and device deletion",
  );
} finally {
  ws?.close();
  await sql`DELETE FROM esphub.accounts WHERE clerk_subject IN (${subject}, ${otherSubject})`;
  await sql.end();
}
