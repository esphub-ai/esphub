import assert from "node:assert/strict";
import postgres from "postgres";
import { setTimeout as delay } from "node:timers/promises";
import { simulatedDevice } from "../tests/fixtures/iot/device.mjs";
import { parseNvs } from "../services/api/src/nvs.js";
import { importPKCS8, SignJWT } from "jose";
import { createHash, createHmac, randomUUID } from "node:crypto";

const base = process.env.TEST_SITE_URL;
if (!base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("A local TEST_SITE_URL is required");

const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
const endpoint = "https://api.esphub.ai/mcp";
const issuer = "https://clerk.esphub.ai";
const subject = "user_" + randomUUID().replaceAll("-", "");
const privateKey = await importPKCS8(process.env.TEST_SIGNING_KEY, "RS256");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nvsOf = (setup) => setup.flash.files.find((f) => f.name === "nvs.bin");
const local = (url) => base + "/backend" + new URL(url).pathname;

function sign(payload, header) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test", ...header })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function issue(scope) {
  return sign(
    {
      iss: issuer,
      aud: endpoint,
      sub: subject,
      jti: randomUUID(),
      client_id: "test-public-client",
      scope,
    },
    { typ: "at+jwt" },
  );
}

const key = await issue("devices:read devices:write");
const read = await issue("devices:read");
const sessionJwt = await sign(
  { iss: issuer, sub: subject, sid: "sess_device", azp: base },
  { typ: "JWT", cat: "cl_B7d4PD111AAA" },
);
const m2mJwt = await sign(
  {
    sub: "mch_local_bootloader",
    jti: "mt_" + randomUUID().replaceAll("-", ""),
    scopes: "mch_local_api",
  },
  { typ: "JWT", cat: "cl_B7d4PD333AAA" },
);

function api(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(base + "/backend" + path, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function checkFlashFiles(setup) {
  for (const file of setup.flash.files.filter((f) => f.name !== "nvs.bin")) {
    const url = new URL(file.url);
    const res = await fetch(base + "/backend" + url.pathname + url.search);
    assert.equal(res.status, 200, file.name);
    assert.equal(sha256(new Uint8Array(await res.arrayBuffer())), file.sha256, file.name);
  }
}

async function downloadNvs(nvs) {
  const res = await fetch(local(nvs.url), { headers: nvs.headers });
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(bytes.byteLength, nvs.size);
  assert.equal(sha256(bytes), nvs.sha256);
  return parseNvs(bytes);
}

async function mcpRequest(method, params, accessToken = key) {
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

async function mcpCall(method, params, accessToken) {
  const res = await mcpRequest(method, params, accessToken);
  const body = await res.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  const msg = JSON.parse(data ? data.slice(6) : body);
  assert.equal(res.status, 200, JSON.stringify(msg));
  assert.ok(!msg.error, JSON.stringify(msg));
  return msg.result;
}

async function op(name, args, accessToken) {
  const r = await mcpCall("tools/call", { name, arguments: args }, accessToken);
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
}

let mcu;
try {
  // 1. OAuth discovery and basic MCP auth/scope boundary.
  const discovery = await (await api("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(discovery.resource, endpoint);
  assert.deepEqual(discovery.authorization_servers, [issuer]);
  assert.equal((await mcpRequest("tools/call", { name: "devices_list", arguments: {} }, null)).status, 401);
  assert.deepEqual(await op("devices_list", {}, read), []);
  assert.equal((await mcpRequest("tools/call", { name: "devices_create", arguments: {} }, read)).status, 403);
  assert.equal(
    (await mcpCall("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "integration", version: "1.0.0" },
    })).serverInfo.name,
    "esphub",
  );
  assert.ok((await mcpCall("tools/list", {})).tools.some(({ name }) => name === "ota_resize_app"));

  // 2. Boards catalog (public REST + MCP search).
  const matches = await op("boards_search", { query: "CaRdPuTeR" }, read);
  const publicMatches = await (await api("/boards?q=CaRdPuTeR")).json();
  assert.deepEqual(matches, publicMatches);
  assert.deepEqual(publicMatches.map((b) => b.id).sort(), ["m5stack/cardputer", "m5stack/cardputer-adv"]);
  const detail = await (await api("/boards/m5stack/cardputer-adv")).json();
  assert.equal(detail.id, "m5stack/cardputer-adv");
  assert.equal(detail.bootloader, "esp32s3-8mb");
  assert.equal(detail.spec.soc, "esp32s3");

  // 3. Virtual device lifecycle.
  const virtual = await op("devices_create_virtual", {});
  assert.equal(virtual.kind, "virtual");
  assert.equal(virtual.board, "esphub/virtual-esp32");
  const vid = { device_id: virtual.id };
  const virtualFw = await op("firmware_get", vid, read);
  const [listedVirtual] = await op("devices_list", {}, read);
  assert.equal(listedVirtual.process_id, virtualFw.process_id);
  assert.notEqual((await op("devices_reboot", vid)).process_id, virtualFw.process_id);
  await op("devices_delete", vid);
  assert.deepEqual(await op("devices_list", {}, read), []);

  // 4. Physical device registration, flash plan, NVS, BLE credential, and web setup with Wi-Fi.
  const d = await op("devices_create", { board: "m5stack/paper-color", name: "Simulator" });
  const id = { device_id: d.id };
  assert.deepEqual(
    d.flash.files.map(({ name }) => name),
    ["bootloader.bin", "partition-table.bin", "nvs.bin", "launcher.bin"],
  );
  await checkFlashFiles(d);
  const dNvs = await downloadNvs(nvsOf(d));
  const deviceToken = dNvs.eh.tok;
  const deviceBleSecret = dNvs.eh.ble_key;
  assert.match(deviceToken, /^eh_dev_/);
  assert.match(deviceBleSecret, /^[0-9a-f]{64}$/);
  assert.equal(dNvs.eh.hub, "api.esphub.ai");
  assert.deepEqual(await op("wifi_ble_credential", id), {
    psk: createHmac("sha256", Buffer.from(deviceBleSecret, "hex"))
      .update("esphub/wifi/tls-psk")
      .digest("hex"),
  });

  const setupRes = await api("/setup", {
    method: "POST",
    token: sessionJwt,
    body: {
      board: "m5stack/stopwatch",
      name: "Watch",
      wifi: { ssid: "LabWiFi", password: "lab-password", hidden: true },
    },
  });
  assert.equal(setupRes.status, 200);
  const watch = await setupRes.json();
  const watchNvs = await downloadNvs(nvsOf(watch));
  assert.deepEqual(JSON.parse(watchNvs.eh.wifis), [{ s: "LabWiFi", p: "lab-password", h: true }]);
  assert.doesNotMatch(watch.prompt, /lab-password/);

  // 5. Private OTA artifact upload and device-authenticated download.
  const appFile = Buffer.alloc(4096, 0xe9);
  const grant = await op("ota_prepare_upload", { ...id, kind: "app", size: appFile.length });
  const uploadRes = await fetch(local(grant.upload_url), {
    method: "PUT",
    headers: grant.headers,
    body: appFile,
  });
  assert.equal(uploadRes.status, 201, await uploadRes.clone().text());
  assert.equal((await uploadRes.json()).url, grant.url);
  const downloaded = await fetch(local(grant.url), {
    headers: { Authorization: "Bearer " + deviceToken, "Accept-Encoding": "identity" },
  });
  assert.equal(downloaded.status, 200);
  assert.ok(Buffer.from(await downloaded.arrayBuffer()).equals(appFile));

  // 6. MQTT enrollment, logs, messaging, Wi-Fi command, OTA install, resize, and reboot.
  mcu = simulatedDevice(base, deviceToken);
  const addresses = { ble_address: "02:11:22:AA:BB:CC", net_mac: "00:11:22:33:44:54" };
  const boot = await mcu.hello({ ...addresses, role: "bootloader", bootloader_version: "1.2.3" });
  const connected = await op("devices_get", id);
  assert.equal(connected.online, true);
  assert.equal(connected.info.role, "bootloader");
  assert.equal(connected.ble_address, addresses.ble_address.toLowerCase());

  const cmdState = (commandId) => op("commands_get", { ...id, command_id: commandId }, read);

  // Logs enable + ingestion + read.
  const toggled = await op("logs_set", { ...id, enabled: true });
  const toggle = await mcu.nextCommand();
  assert.equal(toggle.op, "logs.set");
  assert.deepEqual(toggle.args, { enabled: true });
  await mcu.send({ t: "res", id: toggle.id, ok: true, data: { enabled: true } });
  assert.deepEqual((await cmdState(toggled.command_id)).result, toggle.args);

  const text = "C: 42\n打印 🎉\n";
  await mcu.sendBestEffort({ t: "log", bytes: Buffer.from(text).toString("base64"), dropped: 17 });
  let page;
  for (let i = 0; i < 100; i++) {
    page = await op("logs_read", { ...id, process_id: boot, limit: 1 }, read);
    if (page.records.length) break;
    await delay(20);
  }
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].text, text);
  assert.equal(page.records[0].dropped_bytes, 17);

  // Bidirectional messaging.
  const payload = { text: "Hello", flags: [true, null] };
  const { message_id } = await op("devices_send", { ...id, payload });
  assert.deepEqual(await mcu.nextMessage(), { id: message_id, payload });
  await mcu.sendBestEffort({ t: "message", payload: [23.4], reply_to: message_id });
  let reply;
  for (let i = 0; i < 100 && !reply; i++) {
    const pageAfter = await op("logs_read", { ...id, after: page.cursor }, read);
    reply = pageAfter.records.find((entry) => entry.type === "message");
    if (!reply) await delay(20);
  }
  assert.deepEqual(reply?.payload, [23.4]);
  assert.equal(reply?.reply_to, message_id);

  // Online Wi-Fi command.
  const wifiReq = await op("wifi_add", { ...id, ssid: "field network", password: "fixture passphrase" });
  const save = await mcu.nextCommand();
  assert.equal(save.id, wifiReq.command_id);
  assert.deepEqual(save.args, { name: "wifi", argv: ["add", "field network", "fixture passphrase"] });
  await mcu.send({ t: "res", id: save.id, ok: true, data: { output: "Saved network" } });
  assert.equal((await cmdState(save.id)).state, "succeeded");

  // Bootloader OTA app install.
  assert.equal((await op("bootloader_enter", id)).mode, "bootloader");
  const transferId = randomUUID();
  const queuedOta = await op("ota_install", { ...id, kind: "app", url: grant.url, request_id: transferId });
  const otaCmd = await mcu.nextCommand();
  assert.equal(otaCmd.id, queuedOta.command_id);
  assert.deepEqual(otaCmd.args, {
    url: grant.url,
    kind: "app",
    transfer_id: transferId,
    image_size: appFile.length,
  });
  await mcu.send({ t: "event", name: "install.done", data: { transfer_id: transferId, kind: "app" } });
  assert.equal((await cmdState(otaCmd.id)).state, "succeeded");

  // App partition resize across bootloader reboot.
  const originalLayout = { app_size_bytes: 0x400000, data_size_bytes: 0x160000 };
  const largerLayout = { app_size_bytes: 0x500000, data_size_bytes: 0x60000 };
  await mcu.send({ t: "event", name: "ota.layout", data: originalLayout });
  const resizeId = randomUUID();
  const growReq = await op("ota_resize_app", {
    ...id,
    app_size_bytes: largerLayout.app_size_bytes,
    erase_littlefs: true,
    request_id: resizeId,
  });
  const resize = await mcu.nextCommand();
  assert.equal(resize.id, growReq.command_id);
  assert.equal(resize.op, "resize_app");
  assert.equal(resize.args.data_size_bytes, largerLayout.data_size_bytes);
  await mcu.send({ t: "res", id: resize.id, ok: true, data: { ...largerLayout, rebooting: true } });
  await mcu.hello({ ...addresses, role: "bootloader", bootloader_version: "1.2.3" });
  await mcu.send({
    t: "event",
    name: "install.done",
    data: { ...largerLayout, kind: "resize_app", transfer_id: resizeId },
  });
  assert.equal((await cmdState(resize.id)).state, "succeeded");
  assert.deepEqual((await op("devices_get", id)).info.layout, largerLayout);

  // Exit bootloader to app, inspect firmware inventory, and reboot.
  const exit = await op("bootloader_exit", id);
  const exitCmd = await mcu.nextCommand();
  assert.equal(exitCmd.id, exit.command_id);
  assert.deepEqual(exitCmd.args, { target: "app" });
  const appInfo = {
    ...addresses,
    role: "app",
    fw: { name: "color-bands", version: "2.0.4" },
    sdk_version: "8.0.0",
  };
  await mcu.hello(appInfo);
  assert.equal((await cmdState(exit.command_id)).state, "succeeded");
  const currentApp = await op("devices_get", id);
  assert.equal(currentApp.info.role, "app");
  assert.equal(currentApp.software.bootloader_version, "1.2.3");
  assert.deepEqual(currentApp.software.application, {
    name: "color-bands",
    version: "2.0.4",
    sdk_version: "8.0.0",
    last_seen: false,
  });
  const firmware = await op("firmware_get", id, read);
  const status = await mcu.nextCommand();
  assert.equal(status.id, firmware.command_id);
  assert.equal(status.op, "status");
  await mcu.send({ t: "res", id: status.id, ok: true, data: { fw: currentApp.software.application } });

  const reboot = await op("devices_reboot", id);
  assert.equal((await mcu.nextCommand()).id, reboot.command_id);
  await mcu.hello(appInfo);
  assert.equal((await cmdState(reboot.command_id)).state, "succeeded");

  // 7. Reissue credentials and clean up devices.
  const reissueRes = await api(`/setup/${d.id}/reissue`, {
    method: "POST",
    token: sessionJwt,
    body: { wifi: { ssid: "RecoveryNet", password: "new-password" } },
  });
  assert.equal(reissueRes.status, 200);
  const reissuedNvs = await downloadNvs(nvsOf(await reissueRes.json()));
  assert.notEqual(reissuedNvs.eh.tok, deviceToken);
  assert.notEqual(reissuedNvs.eh.ble_key, deviceBleSecret);
  assert.deepEqual(JSON.parse(reissuedNvs.eh.wifis), [{ s: "RecoveryNet", p: "new-password" }]);
  await op("devices_delete", { device_id: watch.id });
  await op("devices_delete", id);

  // 8. Internal bootloader publishing via Clerk M2M + R2 staging + release promotion.
  const publishLoaderId = "esp32s3-e2e" + randomUUID().slice(0, 6) + "mb";
  const publishVersion = "deadbeef";
  try {
    const uploadsRes = await api("/internal/uploads", {
      method: "POST",
      token: m2mJwt,
      body: { count: 3 },
    });
    assert.equal(uploadsRes.status, 201);
    const { uploads } = await uploadsRes.json();
    const binaries = [Buffer.alloc(64, 0xe9), Buffer.alloc(32, 0xaa), Buffer.alloc(128, 0xe9)];
    for (let i = 0; i < 3; i++) {
      const put = await fetch(base + "/backend/__r2" + new URL(uploads[i].url).pathname, {
        method: "PUT",
        headers: uploads[i].headers,
        body: binaries[i],
      });
      assert.equal(put.status, 200);
    }
    const createRes = await api("/internal/bootloaders", {
      method: "POST",
      token: m2mJwt,
      body: {
        id: publishLoaderId,
        version: publishVersion,
        chip: "esp32s3",
        flash_mode: "dio",
        flash_size: "16MB",
        flash_freq: "80m",
        app_offset: 0x2a0000,
        nvs_offset: 0x9000,
        nvs_size: 0x6000,
        files: {
          bootloader: { upload_id: uploads[0].id, offset: 0, size: binaries[0].length, sha256: sha256(binaries[0]) },
          partition_table: { upload_id: uploads[1].id, offset: 0x8000, size: binaries[1].length, sha256: sha256(binaries[1]) },
          launcher: { upload_id: uploads[2].id, offset: 0x20000, size: binaries[2].length, sha256: sha256(binaries[2]) },
        },
      },
    });
    assert.equal(createRes.status, 201, await createRes.clone().text());
    const promoteRes = await api(`/internal/bootloaders/${publishLoaderId}/current`, {
      method: "PUT",
      token: m2mJwt,
      body: { version: publishVersion },
    });
    assert.equal(promoteRes.status, 200);
    assert.equal((await promoteRes.json()).version, publishVersion);
    const dlLauncher = await api(`/bootloaders/${publishLoaderId}/${publishVersion}/launcher`);
    assert.equal(dlLauncher.status, 200);
    assert.ok(Buffer.from(await dlLauncher.arrayBuffer()).equals(binaries[2]));
  } finally {
    await sql`DELETE FROM esphub.bootloader_releases WHERE id = ${publishLoaderId}`;
    await sql`DELETE FROM esphub.bootloaders WHERE id = ${publishLoaderId}`;
  }

  // 9. Personal Projects API (/v1/* via Clerk API Key) + MCP + CDN + setup with project_id.
  const personalApiKey = "ak_local_subject_" + subject;
  let createdProjectId = null;
  try {
    const mcpProject = await op("projects_create", {
      name: "Cardputer E2E Demo",
      description: "End-to-end project publish test",
      repo_url: "https://github.com/esphub-ai/esphub-projects",
      repo_path: "projects/cardputer-e2e-demo",
    });
    createdProjectId = mcpProject.id;
    const v1ListRes = await api("/v1/projects", { token: personalApiKey });
    assert.equal(v1ListRes.status, 200);
    assert.equal((await v1ListRes.json()).some((p) => p.id === createdProjectId), true);

    const imgBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5, 6, 7, 8]);
    const appBytes = Buffer.alloc(192, 0xe9);
    const v1UpRes = await api("/v1/uploads", {
      method: "POST",
      token: personalApiKey,
      body: {
        files: [
          { size: imgBytes.length, content_type: "image/webp" },
          { size: appBytes.length, content_type: "application/octet-stream" },
        ],
      },
    });
    assert.equal(v1UpRes.status, 201);
    const { uploads: v1Uploads } = await v1UpRes.json();
    for (const [idx, buf] of [imgBytes, appBytes].entries()) {
      const put = await fetch(base + "/backend/__r2" + new URL(v1Uploads[idx].url).pathname, {
        method: "PUT",
        headers: v1Uploads[idx].headers,
        body: buf,
      });
      assert.equal(put.status, 200);
    }

    const imgSha = sha256(imgBytes);
    const appSha = sha256(appBytes);
    const putProjRes = await api(`/v1/projects/${createdProjectId}`, {
      method: "PUT",
      token: personalApiKey,
      body: {
        name: "Cardputer E2E Demo",
        description: "Published E2E demo",
        repo_url: "https://github.com/esphub-ai/esphub-projects",
        repo_path: "projects/cardputer-e2e-demo",
        images: [{
          upload_id: v1Uploads[0].id,
          sha256: imgSha,
          size: imgBytes.length,
          content_type: "image/webp",
          is_cover: true,
        }],
      },
    });
    assert.equal(putProjRes.status, 200, await putProjRes.clone().text());
    assert.equal(
      (await putProjRes.json()).cover_image_url,
      `https://cdn.esphub.ai/projects/${createdProjectId}/images/${imgSha}.webp`,
    );

    const cdnImg = await api(`/__cdn/projects/${createdProjectId}/images/${imgSha}.webp`);
    assert.equal(cdnImg.status, 200);
    assert.ok(Buffer.from(await cdnImg.arrayBuffer()).equals(imgBytes));

    const relRes = await api(`/v1/projects/${createdProjectId}/releases`, {
      method: "POST",
      token: personalApiKey,
      body: {
        board_id: "m5stack/cardputer-adv",
        version: "1.0.0",
        sdk_version: "8.2.0",
        idf_version: "5.5.4",
        source_revision: "b".repeat(40),
        app: {
          upload_id: v1Uploads[1].id,
          size: appBytes.length,
          sha256: appSha,
          elf_sha256: "c".repeat(64),
        },
      },
    });
    assert.equal(relRes.status, 201, await relRes.clone().text());

    // Newly created project defaults to private: hidden from public directory and unsigned downloads.
    assert.equal(mcpProject.visibility, "private");
    const privList = await (await api("/projects?board=m5stack/cardputer-adv&q=E2E")).json();
    assert.equal(privList.some((p) => p.id === createdProjectId), false);
    const privDl = await api(`/projects/${createdProjectId}/boards/m5stack/cardputer-adv/app`);
    assert.equal(privDl.status, 404);

    // Non-@okou.ai account cannot set official author_id or official tags (factory/example).
    const badAuthorRes = await api(`/v1/projects/${createdProjectId}`, {
      method: "PUT",
      token: personalApiKey,
      body: {
        name: "Cardputer E2E Demo",
        description: "Published E2E demo",
        repo_url: "https://github.com/esphub-ai/esphub-projects",
        repo_path: "projects/cardputer-e2e-demo",
        author_id: "m5stack",
      },
    });
    assert.equal(badAuthorRes.status, 403);
    const badTagRes = await api(`/v1/projects/${createdProjectId}`, {
      method: "PUT",
      token: personalApiKey,
      body: {
        name: "Cardputer E2E Demo",
        description: "Published E2E demo",
        repo_url: "https://github.com/esphub-ai/esphub-projects",
        repo_path: "projects/cardputer-e2e-demo",
        tags: ["factory"],
      },
    });
    assert.equal(badTagRes.status, 403);

    // Owner can still flash their own private project during USB setup (signed URL).
    const privSetupRes = await api("/setup", {
      method: "POST",
      token: sessionJwt,
      body: {
        board: "m5stack/cardputer-adv",
        name: "Cardputer Private Flash",
        project_id: createdProjectId,
      },
    });
    assert.equal(privSetupRes.status, 200, await privSetupRes.clone().text());
    const privDevice = await privSetupRes.json();
    const signedAppUrl = privDevice.flash.files.find((f) => f.name === "app.bin").url;
    assert.match(signedAppUrl, /\?exp=\d+&sig=[0-9a-f]{64}$/);
    await checkFlashFiles(privDevice);
    await op("devices_delete", { device_id: privDevice.id });

    // Publish project via MCP projects_set_visibility -> visible publicly with owner profile.
    const madePublic = await op("projects_set_visibility", {
      project_id: createdProjectId,
      visibility: "public",
    });
    assert.equal(madePublic.visibility, "public");
    assert.equal(madePublic.owner?.name, "e2e_maker");

    const pubList = await (await api("/projects?board=m5stack/cardputer-adv&q=E2E")).json();
    assert.equal(pubList.some((p) => p.id === createdProjectId), true);
    const mcpSearch = await op("projects_search", { board: "m5stack/cardputer-adv", query: "E2E" }, read);
    assert.equal(mcpSearch.some((p) => p.id === createdProjectId), true);

    const latestDl = await api(`/projects/${createdProjectId}/boards/m5stack/cardputer-adv/app`);
    assert.equal(latestDl.status, 200);
    assert.ok(Buffer.from(await latestDl.arrayBuffer()).equals(appBytes));

    const projSetupRes = await api("/setup", {
      method: "POST",
      token: sessionJwt,
      body: {
        board: "m5stack/cardputer-adv",
        name: "Cardputer Project Flash",
        project_id: createdProjectId,
      },
    });
    assert.equal(projSetupRes.status, 200, await projSetupRes.clone().text());
    const projDevice = await projSetupRes.json();
    assert.deepEqual(
      projDevice.flash.files.map(({ name }) => name),
      ["bootloader.bin", "partition-table.bin", "nvs.bin", "launcher.bin", "app.bin"],
    );
    assert.equal(projDevice.flash.files.find((f) => f.name === "app.bin").sha256, appSha);
    await checkFlashFiles(projDevice);
    await op("devices_delete", { device_id: projDevice.id });

    assert.equal((await api(`/v1/projects/${createdProjectId}`, { method: "DELETE", token: personalApiKey })).status, 200);
    assert.equal((await api(`/projects/${createdProjectId}`)).status, 404);
  } finally {
    if (createdProjectId) {
      await sql`DELETE FROM esphub.project_boards WHERE project_id = ${createdProjectId}`;
      await sql`DELETE FROM esphub.project_releases WHERE project_id = ${createdProjectId}`;
      await sql`DELETE FROM esphub.project_images WHERE project_id = ${createdProjectId}`;
      await sql`DELETE FROM esphub.projects WHERE id = ${createdProjectId}`;
    }
  }

  console.log(
    "PASS MCP auth, boards, virtual/physical devices, MQTT logs/commands/OTA/resize, reissue, bootloader M2M, and Projects API",
  );
} finally {
  mcu?.close();
  await sql`DELETE FROM esphub.accounts WHERE clerk_subject = ${subject}`;
  await sql.end();
}
