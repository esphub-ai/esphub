import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { operate, validate } from "../services/api/src/operations.js";
import { releaseUrl } from "../shared/identity.js";
import { jsonBucket, setupRelease } from "./fixtures/setup-release.mjs";

const { source, boards } = JSON.parse(await readFile(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const profiles = Object.fromEntries(boards.map((board) => [board.id,
  { ...board, source_revision: source.revision, sdk_version: source.sdk_version, sdk_source_url: source.sdk_source_url, is_current: true }]));

test("registration returns the exact example from the immutable kit when the catalog moves ahead", async () => {
  const id = "m5stack/stopwatch", profile = profiles[id];
  const current = profile.published_examples.find((e) => e.id === profile.default_example);
  const kitExample = { ...current, source_url: "https://source.example/an-earlier-revision/" + current.id };
  const { tag, files, assets, manifest } = setupRelease(id, profile, kitExample);
  const sql = async (query) => {
    const text = query.join("?");
    if (text.includes("INSERT INTO esphub.devices"))
      return [{ id: "test-id", board: id, name: "Watch", kind: "physical" }];
    if (text.includes("esphub.release_assets"))
      return assets.filter((row) => row.asset === "setup-manifest");
    return [{ ...profile, setup_tag: tag }];
  };
  const result = await operate({ sql, env: { FIRMWARE: jsonBucket(files) } }, "owner",
    "devices_create", { board: id, name: "Watch" });
  assert.match(result.token, /^eh_dev_/);
  assert.match(result.ble_secret, /^[a-f0-9]{64}$/);
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
