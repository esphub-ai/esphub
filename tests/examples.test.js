import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { operate, validate } from "../services/api/src/operations.js";
import { parseNvs } from "../services/api/src/nvs.js";
import { bootloaderUrl, releaseUrl } from "../shared/identity.js";
import { appRelease, bootloaderSet, fixtureBucket } from "./fixtures/firmware.mjs";

const { source, boards } = JSON.parse(await readFile(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const profiles = Object.fromEntries(boards.map((board) => [board.id,
  { ...board, retired: false, source_revision: source.revision, sdk_version: source.sdk_version, sdk_source_url: source.sdk_source_url, is_current: true }]));

// Answers the setup queries from a fixture bootloader set and app release.
function setupContext(board, { bootloader = true } = {}) {
  const profile = profiles[board];
  const set = bootloaderSet(profile.bootloader);
  const app = appRelease(board);
  const staged = [];
  const sql = async (query) => {
    const text = query.join("?");
    if (text.includes("INSERT INTO esphub.devices"))
      return [{ id: "test-id", board, name: "Watch", kind: "physical" }];
    if (text.includes("esphub.bootloaders")) return bootloader ? [set.row] : [];
    if (text.includes("esphub.firmware_releases"))
      return [{ ...app.release, object_key: app.asset.object_key, size: app.asset.size }];
    return [profile];
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
  const files = new Map([...set.files, ...app.files]);
  return { c: { sql, env: { FIRMWARE: fixtureBucket(files), DEVICE } }, profile, set, app, staged };
}

test("registration returns a flash plan for the shared bootloader, the app and a private NVS image", async () => {
  const board = "m5stack/stopwatch";
  const { c, profile, set, app, staged } = setupContext(board);
  const wifi = { ssid: "Lab", password: "secret", hidden: true };
  const result = await operate(c, "owner", "devices_create", { board, name: "Watch", wifi });
  assert.equal("token" in result, false);
  assert.equal("ble_secret" in result, false);
  assert.equal("nvs" in result, false);
  assert.equal("setup_manifest" in result, false);

  const { flash } = result;
  assert.deepEqual(
    flash.files.map(({ name, offset }) => [name, offset]),
    [["bootloader.bin", "0x0"], ["partition-table.bin", "0x8000"], ["nvs.bin", "0x9000"],
      ["launcher.bin", "0x20000"], ["app.bin", "0x2a0000"]],
  );
  const file = (name) => flash.files.find((item) => item.name === name);
  assert.equal(file("launcher.bin").url, bootloaderUrl(set.row.id, set.row.version, "launcher"));
  assert.equal(file("launcher.bin").sha256, set.row.launcher_sha256);
  assert.equal(file("app.bin").url, releaseUrl(board, "app", app.release.tag));
  assert.equal(file("app.bin").sha256, createHash("sha256").update(app.files.values().next().value).digest("hex"));
  assert.deepEqual(file("nvs.bin").headers, { Authorization: "Bearer eh_nvs_" + "A".repeat(43) });
  assert.ok(file("nvs.bin").expires_at);
  assert.equal(flash.command,
    "esptool.py --chip esp32s3 --port PORT write_flash --erase-all --flash_mode dio --flash_size 16MB --flash_freq 80m " +
    "0x0 bootloader.bin 0x8000 partition-table.bin 0x9000 nvs.bin 0x20000 launcher.bin 0x2a0000 app.bin");
  assert.deepEqual(flash.bootloader, { id: "esp32s3-16mb", version: "2.0.7" });
  assert.equal(flash.app_version, "2.0.7");

  const [nvs] = staged;
  assert.equal(nvs.byteLength, set.row.nvs_size);
  const parsed = parseNvs(nvs);
  assert.match(parsed.eh.tok, /^eh_dev_/);
  assert.match(parsed.eh.ble_key, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(parsed.eh.wifis), [{ s: "Lab", p: "secret", h: true }]);

  assert.match(result.prompt, /pip install esptool/);
  assert.ok(result.prompt.includes(flash.command));
  assert.match(result.prompt, /already contains the Wi-Fi network/);
  assert.doesNotMatch(result.prompt, /secret/);
  assert.deepEqual(result.setup_example,
    profile.published_examples.find((example) => example.id === profile.default_example));
  assert.deepEqual(result.firmware, {
    app: { version: "2.0.7", download_url: releaseUrl(board, "app", app.release.tag) },
    bootloader: { id: "esp32s3-16mb", version: "2.0.7",
      download_url: bootloaderUrl("esp32s3-16mb", "2.0.7", "launcher") },
  });
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
});

test("OTA accepts either the published app or bootloader or an explicit HTTPS binary", () => {
  const device_id = crypto.randomUUID();
  for (const kind of ["bootloader", "app"]) {
    validate("ota_install", { device_id, kind });
    validate("ota_install", { device_id, kind, url: "https://example.com/app.bin" });
    for (const url of ["http://example.com/a", "https://user:password@example.com/a",
      "https://example.com/a#b", "https://example.com/" + "a".repeat(1024)])
      assert.throws(() => validate("ota_install", { device_id, kind, url }));
  }
});
