import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { operate, validate } from "../services/api/src/operations.js";
import { parseNvs } from "../services/api/src/nvs.js";
import { bootloaderUrl, projectAppUrl } from "../shared/identity.js";
import { bootloaderSet, fixtureBucket } from "./fixtures/firmware.mjs";

const { boards } = JSON.parse(await readFile(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(boards.map((board) => [board.id, { ...board, vendor: board.id.split("/")[0], retired: false }]));

// Answers the setup queries from a fixture bootloader set and optional project release.
function setupContext(board, { bootloader = true, projectRelease = null } = {}) {
  const row = byId[board];
  const set = bootloaderSet(row.bootloader);
  const staged = [];
  let inserted = 0;
  const sql = async (query, ...values) => {
    const text = query.join("?");
    if (text.includes("INSERT INTO esphub.devices")) {
      inserted++;
      return [{ id: "test-id", board, name: "Watch", kind: "physical" }];
    }
    if (text.includes("esphub.bootloaders")) return bootloader ? [set.row] : [];
    if (text.includes("esphub.project_releases")) {
      if (!projectRelease) return [];
      const [projectId, boardId, version] = values;
      if (
        projectId === projectRelease.project_id &&
        boardId === projectRelease.board_id &&
        (version === undefined || version === projectRelease.version)
      )
        return [projectRelease];
      return [];
    }
    return [row];
  };
  const DEVICE = {
    idFromName: (deviceId) => deviceId,
    get: () => ({
      async fetch(url, init) {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        staged.push(bytes);
        const offset = Number(new URL(url).searchParams.get("offset"));
        return Response.json({
          url: "https://api.esphub.ai/setup/test-id/nvs-id",
          headers: { Authorization: "Bearer eh_nvs_" + "A".repeat(43) },
          offset: "0x" + offset.toString(16),
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          expires_at: new Date(Date.now() + 900000).toISOString(),
        });
      },
    }),
  };
  const files = new Map(set.files);
  if (projectRelease?.body) files.set(projectRelease.app_key, projectRelease.body);
  return {
    c: { sql, env: { FIRMWARE: fixtureBucket(files), DEVICE } },
    row,
    set,
    staged,
    get inserted() { return inserted; },
  };
}

test("default registration returns a 4-file flash plan for the shared bootloader set and private NVS image", async () => {
  const board = "m5stack/stopwatch";
  const { c, set, staged } = setupContext(board);
  const wifi = { ssid: "Lab", password: "secret", hidden: true };
  const result = await operate(c, "owner", "devices_create", { board, name: "Watch", wifi });
  assert.equal("token" in result, false);
  assert.equal("ble_secret" in result, false);
  assert.equal("nvs" in result, false);
  assert.equal("setup_manifest" in result, false);
  assert.equal("setup_example" in result, false);
  assert.equal("examples" in result, false);
  assert.equal("sources" in result, false);

  const { flash } = result;
  assert.deepEqual(
    flash.files.map(({ name, offset }) => [name, offset]),
    [["bootloader.bin", "0x0"], ["partition-table.bin", "0x8000"], ["nvs.bin", "0x9000"], ["launcher.bin", "0x20000"]],
  );
  const file = (name) => flash.files.find((item) => item.name === name);
  assert.equal(file("launcher.bin").url, bootloaderUrl(set.row.id, set.row.version, "launcher"));
  assert.equal(file("launcher.bin").sha256, set.row.launcher_sha256);
  assert.deepEqual(file("nvs.bin").headers, { Authorization: "Bearer eh_nvs_" + "A".repeat(43) });
  assert.ok(file("nvs.bin").expires_at);
  assert.equal(
    flash.command,
    "esptool.py --chip esp32s3 --port PORT write_flash --erase-all --flash_mode dio --flash_size 16MB --flash_freq 80m " +
      "0x0 bootloader.bin 0x8000 partition-table.bin 0x9000 nvs.bin 0x20000 launcher.bin",
  );
  assert.deepEqual(flash.bootloader, { id: "esp32s3-16mb", version: "2.0.7" });
  assert.equal("app_version" in flash, false);
  assert.equal("project" in flash, false);

  const [nvs] = staged;
  assert.equal(nvs.byteLength, set.row.nvs_size);
  const parsed = parseNvs(nvs);
  assert.match(parsed.eh.tok, /^eh_dev_/);
  assert.match(parsed.eh.ble_key, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(parsed.eh.wifis), [{ s: "Lab", p: "secret", h: true }]);

  assert.match(result.prompt, /pip install esptool/);
  assert.ok(result.prompt.includes(flash.command));
  assert.match(result.prompt, /already contains the Wi-Fi network/);
  assert.match(result.prompt, /projects_search/);
  assert.doesNotMatch(result.prompt, /secret/);
  assert.deepEqual(result.spec, {
    soc: "esp32s3",
    flash_mb: 16,
    flash_bus: "quad",
    psram: null,
    console: "usb-serial-jtag",
  });
  assert.deepEqual(result.firmware, {
    bootloader: {
      id: "esp32s3-16mb",
      version: "2.0.7",
      download_url: bootloaderUrl("esp32s3-16mb", "2.0.7", "launcher"),
    },
  });
});

test("registration with optional project_id includes the project app.bin in the flash plan", async () => {
  const board = "m5stack/stopwatch";
  const projectId = crypto.randomUUID();
  const body = new Uint8Array(256).fill(0xe9);
  const sha = createHash("sha256").update(body).digest("hex");
  const release = {
    project_id: projectId,
    board_id: board,
    version: "1.2.3",
    app_key: `projects/${projectId}/releases/${board}/1.2.3/app.bin`,
    app_size: body.length,
    app_sha256: sha,
    body,
  };
  const { c } = setupContext(board, { projectRelease: release });
  const result = await operate(c, "owner", "devices_create", {
    board,
    name: "Watch",
    wifi: { ssid: "Lab" },
    project_id: projectId,
    version: "1.2.3",
  });
  assert.deepEqual(
    result.flash.files.map(({ name, offset }) => [name, offset]),
    [["bootloader.bin", "0x0"], ["partition-table.bin", "0x8000"], ["nvs.bin", "0x9000"],
      ["launcher.bin", "0x20000"], ["app.bin", "0x2a0000"]],
  );
  const appFile = result.flash.files.find((item) => item.name === "app.bin");
  assert.equal(appFile.url, projectAppUrl(projectId, board, "1.2.3"));
  assert.equal(appFile.sha256, sha);
  assert.deepEqual(result.flash.project, {
    id: projectId,
    version: "1.2.3",
    download_url: projectAppUrl(projectId, board, "1.2.3"),
  });
  assert.match(result.prompt, /bootloader_exit/);

  // Unknown project or version without project_id fails before creating a device.
  const empty = setupContext(board);
  await assert.rejects(
    operate(empty.c, "owner", "devices_create", { board, name: "Watch", version: "1.2.3" }),
    (error) => error.status === 400 && /project_id/.test(error.message),
  );
  await assert.rejects(
    operate(empty.c, "owner", "devices_create", { board, name: "Watch", project_id: projectId }),
    (error) => error.status === 404,
  );
  assert.equal(empty.inserted, 0);
});

test("registration without Wi-Fi asks for it, and an unpublished bootloader fails before registering", async () => {
  const open = setupContext("m5stack/core2");
  const result = await operate(open.c, "owner", "devices_create", { board: "m5stack/core2", name: "Core" });
  assert.equal(parseNvs(open.staged[0]).eh.wifis, undefined);
  assert.match(result.prompt, /has no Wi-Fi network/);
  assert.equal(result.flash.files[0].offset, "0x1000");

  const missing = setupContext("m5stack/core2", { bootloader: false });
  await assert.rejects(
    operate(missing.c, "owner", "devices_create", { board: "m5stack/core2", name: "Core" }),
    (error) => error.status === 503,
  );
  assert.equal(missing.staged.length, 0);
  assert.equal(missing.inserted, 0);
});

test("OTA requires url for app installs, allows omitting url for bootloaders, and rejects project_id", () => {
  const device_id = crypto.randomUUID();
  validate("ota_install", { device_id, kind: "bootloader" });
  validate("ota_install", { device_id, kind: "bootloader", url: "https://example.com/launcher.bin" });
  assert.throws(
    () => validate("ota_install", { device_id, kind: "app" }),
    (error) => error.status === 400 && /url/.test(error.message),
  );
  validate("ota_install", { device_id, kind: "app", url: "https://example.com/app.bin" });
  assert.throws(
    () => validate("ota_install", { device_id, kind: "app", project_id: crypto.randomUUID() }),
    (error) => error.status === 400,
  );
  for (const kind of ["bootloader", "app"]) {
    for (const url of [
      "http://example.com/a",
      "https://user:password@example.com/a",
      "https://example.com/a#b",
      "https://example.com/" + "a".repeat(1024),
    ])
      assert.throws(() => validate("ota_install", { device_id, kind, url }));
  }
});
