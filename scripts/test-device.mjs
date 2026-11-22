import assert from "node:assert/strict";
import postgres from "postgres";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { importPKCS8, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
const base = process.env.TEST_SITE_URL;
if (!base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("A local TEST_SITE_URL is required");
const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
const flash = await mkdtemp(join(tmpdir(), "esphub-sim-flash-"));
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
  assert.equal(listed.length, 18);
  const readOnly = new Set([
    "devices.list",
    "devices.get",
    "wifi.list",
    "firmware.get",
    "uart.sessions",
    "uart.read",
  ]);
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
  const d = await op("devices.create", {
      board: "paper-color",
      name: "Simulator",
    }),
    id = { device_id: d.id };
  assert.match(d.prompt, /hidden SSID/);
  assert.match(d.verification_source, /Hello, M5Stack Paper Color/);
  assert.equal(
    d.setup_manifest,
    "https://api.esphub.ai/releases/paper-color/setup-manifest",
  );
  const watch = await op("devices.create", {
    board: "stopwatch",
    name: "Watch",
  });
  assert.match(watch.verification_source, /Hello, M5Stack Stopwatch/);
  assert.match(watch.verification_source, /setBrightness/);
  await op("devices.delete", { device_id: watch.id });
  const other = await issue("devices:read devices:write", {
    sub: otherSubject,
  });
  for (const name of ["devices.get", "devices.delete"]) {
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
  let resets = 0;
  ws.on("message", (msg) => {
    const f = JSON.parse(msg.toString());
    inbox.push(f);
    if (f.t === "req") {
      let data = { output: "test Wi-Fi network" };
      if (f.op === "py.exec") {
        const code = f.args.code.replaceAll("/flash/", flash + "/");
        const run = spawnSync("python3", ["-I", "-c", code], {
          encoding: "utf8",
        });
        data = {
          output: run.stdout,
          exception: run.status === 0 ? null : run.stderr,
        };
      }
      if (f.op === "py.reset") {
        resets++;
        data = {};
      }
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
  send({ t: "log", seq: 1, lines: [[121, "I", "boot log"]] });
  await take((f) => f.t === "ack" && f.seq === 1);
  assert.equal(
    (await op("uart.read", { ...session, after: 0 }, read)).records[0].text,
    "boot log",
  );
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
  await op("firmware.get", id, read);
  assert.equal((await op("wifi.scan", id)).output, "test Wi-Fi network");
  const install = (source, accessToken) =>
    call(
      "tools/call",
      {
        name: "programs.install",
        arguments: { ...id, source },
      },
      accessToken,
    );
  const hello = d.verification_source;
  assert.match((await install(hello)).content[0].text, /runtime/);
  assert.match((await install(hello, other)).content[0].text, /not found/i);
  send({
    t: "hello",
    boot_id: session.process_id,
    role: "app",
    board: "paper-color",
    fw: { name: "micropython" },
  });
  await take((f) => f.t === "ack");
  const source = hello + "# " + "é".repeat(3500) + "\n";
  const receipt = await op("programs.install", { ...id, source });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.bytes, Buffer.byteLength(source));
  assert.equal(
    receipt.sha256,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(receipt.process_id, session.process_id);
  assert.equal(receipt.restart, "acknowledged");
  assert.equal(await readFile(join(flash, "main.py"), "utf8"), source);
  assert.equal((await install("if (")).isError, true);
  assert.equal(await readFile(join(flash, "main.py"), "utf8"), source);
  assert.equal(resets, 1);
  send({
    t: "hello",
    boot_id: randomUUID(),
    fw: { name: "launcher", version: "test" },
  });
  await take((f) => f.t === "ack");
  const archived = await call("tools/call", {
    name: "uart.write",
    arguments: { ...data, request_id: randomUUID() },
  });
  assert.equal(archived.isError, true);
  await op("devices.delete", id);
  console.log(
    "PASS Clerk OAuth discovery, 18 MCP tools, verified MicroPython installation, scoped access and owner isolation, authenticated simulated MCU, boot isolation, RX idempotency and ACK, R2 TX replay, live RPC and device deletion",
  );
} finally {
  ws?.close();
  await rm(flash, { recursive: true, force: true });
  await sql`DELETE FROM esphub.accounts WHERE clerk_subject IN (${subject}, ${otherSubject})`;
  await sql.end();
}
