import assert from "node:assert/strict";
import test from "node:test";
import { releaseFile, releaseResponse } from "../services/api/src/releases.js";
import { bootloaderResponse } from "../services/api/src/firmware.js";
import { bootloaderSet, fixtureBucket } from "./fixtures/firmware.mjs";

const board = "m5stack/stopwatch";
// Tags and object keys are opaque publisher records, so they need no particular naming.
const index = [
  { tag: "app-one", asset: "app", board, object_key: "objects/app-one.bin", size: "3" },
  { tag: "app-two", asset: "app", board, object_key: "objects/app-two.bin", size: null },
];
const latest = "app-two";

// Mirrors the two release queries: the latest app joins firmware_releases by tag.
const sql = async (strings, ...values) => {
  const [where, tag] = values;
  const isLatest = strings.join("?").includes("esphub.firmware_releases");
  return index.filter((row) => row.board === where && (isLatest ? row.tag === latest : row.tag === tag));
};

test("app files resolve from the publisher's index and latest downloads revalidate", async () => {
  const bucket = fixtureBucket(new Map([
    ["objects/app-one.bin", Uint8Array.of(1, 1, 1)],
    ["objects/app-two.bin", Uint8Array.of(2, 2)],
  ]));
  const get = (where, asset, tag) => releaseResponse(where, asset, tag, sql, bucket);

  const pinned = await get(board, "app", "app-one");
  assert.match(pinned.headers.get("Cache-Control"), /immutable/);
  assert.deepEqual(new Uint8Array(await pinned.arrayBuffer()), Uint8Array.of(1, 1, 1));
  const current = await get(board, "app");
  assert.match(current.headers.get("Cache-Control"), /must-revalidate/);
  assert.deepEqual(new Uint8Array(await current.arrayBuffer()), Uint8Array.of(2, 2));

  assert.deepEqual(await releaseFile(sql, board, "app-one"),
    { tag: "app-one", asset: "app", board, object_key: "objects/app-one.bin", size: 3 });
  assert.equal((await releaseFile(sql, board)).size, null);

  for (const [where, asset, tag] of [
    ["m5stack/core2", "app", "app-one"], // another board's download
    [board, "app", "app-three"],
    [board, "setup", undefined], // setup kits are no longer published
    [board, "ota", undefined],
    ["../secrets", "app", undefined],
  ])
    await assert.rejects(get(where, asset, tag), (e) => e.status === 404, `${where} ${asset} ${tag}`);
  const empty = fixtureBucket(new Map());
  await assert.rejects(releaseResponse(board, "app", "app-one", sql, empty), (e) => e.status === 503);
});

test("bootloader set files download by ID, version and file with immutable caching", async () => {
  const set = bootloaderSet("esp32s3-16mb");
  const rows = [set.row];
  const lookup = async (strings, ...values) => {
    const [id, version] = values;
    return rows.filter((row) => row.id === id && row.version === version);
  };
  const bucket = fixtureBucket(set.files);
  const response = await bootloaderResponse(lookup, bucket, "esp32s3-16mb", "2.0.7", "launcher");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /immutable/);
  assert.equal(response.headers.get("Content-Length"), "128");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), set.files.get(set.row.launcher_key));
  const table = await bootloaderResponse(lookup, bucket, "esp32s3-16mb", "2.0.7", "partition-table");
  assert.deepEqual(new Uint8Array(await table.arrayBuffer()), set.files.get(set.row.partition_table_key));

  for (const [id, version, file] of [
    ["esp32s3-16mb", "2.0.8", "launcher"],
    ["esp32s3-16mb", "2.0.7", "app"],
    ["esp32s3-16mb", "2.0.7", "toString"],
    ["../secrets", "2.0.7", "launcher"],
    ["esp32s3-16mb", "latest", "launcher"],
  ])
    await assert.rejects(bootloaderResponse(lookup, bucket, id, version, file),
      (e) => e.status === 404, `${id} ${version} ${file}`);
  await assert.rejects(bootloaderResponse(lookup, fixtureBucket(new Map()), "esp32s3-16mb", "2.0.7", "bootloader"),
    (e) => e.status === 503);
});
