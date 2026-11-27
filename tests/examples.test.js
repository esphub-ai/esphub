import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { operate, validate } from "../services/api/src/operations.js";
import { parseNvs } from "../services/api/src/nvs.js";
import { releaseUrl } from "../shared/identity.js";
import { jsonBucket, setupRelease } from "./fixtures/setup-release.mjs";

const { source, boards } = JSON.parse(await readFile(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const profiles = Object.fromEntries(boards.map((board) => [board.id,
  { ...board, source_revision: source.revision, sdk_version: source.sdk_version, sdk_source_url: source.sdk_source_url, is_current: true }]));

test("registration returns the exact example from the immutable kit and a private NVS image without raw secrets", async () => {
  const id = "m5stack/stopwatch", profile = profiles[id];
  const current = profile.published_examples.find((e) => e.id === profile.default_example);
  const kitExample = { ...current, source_url: "https://source.example/an-earlier-revision/" + current.id };
  const { tag, files, assets, manifest } = setupRelease(id, profile, kitExample);
  let stagedBytes = null;
  const sql = async (query) => {
    const text = query.join("?");
    if (text.includes("INSERT INTO esphub.devices"))
      return [{ id: "test-id", board: id, name: "Watch", kind: "physical" }];
    if (text.includes("esphub.release_assets"))
      return assets.filter((row) => row.asset === "setup-manifest");
    return [{ ...profile, setup_tag: tag }];
  };
  const DEVICE = {
    idFromName: (deviceId) => deviceId,
    get: () => ({
      async fetch(url, init) {
        stagedBytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        const offset = Number(new URL(url).searchParams.get("offset"));
        return Response.json({
          url: "https://api.esphub.ai/setup/test-id/nvs-id",
          headers: { Authorization: "Bearer eh_nvs_" + "A".repeat(43) },
          offset: "0x" + offset.toString(16),
          size: stagedBytes.byteLength,
          sha256: createHash("sha256").update(stagedBytes).digest("hex"),
          expires_at: new Date(Date.now() + 900000).toISOString(),
        });
      },
    }),
  };
  const result = await operate({ sql, env: { FIRMWARE: jsonBucket(files), DEVICE } }, "owner",
    "devices_create", { board: id, name: "Watch" });
  assert.equal("token" in result, false);
  assert.equal("ble_secret" in result, false);
  assert.equal(result.nvs.offset, "0x9000");
  assert.equal(result.nvs.size, 0x6000);
  const parsed = parseNvs(stagedBytes);
  assert.match(parsed.eh.tok, /^eh_dev_/);
  assert.match(parsed.eh.ble_key, /^[a-f0-9]{64}$/);
  assert.equal(parsed.eh.hub, "api.esphub.ai");
  assert.equal(parsed.eh.hold, 1);
  assert.deepEqual(result.setup_example, manifest.example);
  assert.equal(result.setup_manifest, releaseUrl(id, "setup-manifest", tag));
  assert.deepEqual(result.examples, profile.published_examples);
  assert.notEqual(result.examples[0].source_url, result.setup_example.source_url);
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
