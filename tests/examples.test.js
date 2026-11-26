import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { readBoardCatalog } from "../firmware-source/scripts/board-catalog.mjs";
import { updateSources } from "../services/api/src/update-sources.js";
import { operate, validate } from "../services/api/src/operations.js";
import { fixtureVersion, jsonBucket, setupRelease } from "./fixtures/setup-release.mjs";

const { boards, sdk_version, revision } = await readBoardCatalog();
test("every catalog example opens the matching pinned source and build instructions", () => {
  for (const [id, board] of Object.entries(boards)) {
    const result = updateSources({ ...board, id, source_revision: revision, sdk_version });
    assert.ok(result.examples.some(e => e.id === result.default_example), id);
    assert.equal(result.sources.sdk.version, sdk_version);
    for (const example of result.examples) {
      const directory = `firmware/board/${id}/examples/${example.id}`;
      assert.ok(example.source_url.endsWith(`/tree/${revision}/${directory}`));
      assert.ok(existsSync(`firmware-source/${directory}/${example.entrypoint}`));
      assert.ok(example.build_guide_url.endsWith(`/blob/${revision}/docs/build-examples.md`));
      assert.equal(example.build_command, `python3 scripts/build-example.py ${id} --example ${example.id}`);
      assert.ok(example.description.trim());
    }
  }
});

test("registration returns the exact example from the immutable kit when the catalog moves ahead", async () => {
  const id = "m5stack/stopwatch", board = boards[id];
  const { files, manifest } = setupRelease(id, board, "a".repeat(40));
  const profile = { ...board, id, source_revision: revision, sdk_version, setup_version: fixtureVersion };
  const sql = async (query) => {
    if (query.join("?").includes("INSERT INTO esphub.devices"))
      return [{ id: "test-id", board: id, name: "Watch", kind: "physical" }];
    return [profile];
  };
  const result = await operate({ sql, env: { FIRMWARE: jsonBucket(files) } }, "owner",
    "devices.create", { board: id, name: "Watch" });
  assert.match(result.token, /^eh_dev_/);
  assert.match(result.ble_secret, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.setup_example, manifest.example);
  assert.ok(result.setup_manifest.endsWith("?tag=" + manifest.tag));
  assert.notEqual(result.examples[0].source_url, result.setup_example.source_url);
});

test("OTA accepts either the published app or bootloader or an explicit HTTPS binary", () => {
  const device_id = crypto.randomUUID();
  for (const kind of ["bootloader", "app"]) {
    validate("ota.install", { device_id, kind });
    validate("ota.install", { device_id, kind, url: "https://example.com/app.bin" });
    for (const url of ["http://example.com/a", "https://user:password@example.com/a",
      "https://example.com/a#b", "https://example.com/" + "a".repeat(1024)])
      assert.throws(() => validate("ota.install", { device_id, kind, url }));
  }
});
