import assert from "node:assert/strict";
import test from "node:test";
import { bootloaderResponse } from "../services/api/src/firmware.js";
import { bootloaderSet, fixtureBucket } from "./fixtures/firmware.mjs";

test("bootloader set files download by ID, version and file with immutable caching", async () => {
  const semverSet = bootloaderSet("esp32s3-16mb", "2.0.7");
  const prereleaseSet = bootloaderSet("esp32s3-16mb", "2.0.7-rc.1");
  const commitSet = bootloaderSet("esp32s3-16mb", "a1b2c3d");
  const rows = [semverSet.row, prereleaseSet.row, commitSet.row];
  const lookup = async (strings, ...values) => {
    const [id, version] = values;
    return rows.filter((row) => row.id === id && row.version === version);
  };
  const bucket = fixtureBucket(
    new Map([...semverSet.files, ...prereleaseSet.files, ...commitSet.files]),
  );
  const response = await bootloaderResponse(lookup, bucket, "esp32s3-16mb", "2.0.7", "launcher");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /immutable/);
  assert.equal(response.headers.get("Content-Length"), "128");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), semverSet.files.get(semverSet.row.launcher_key));
  const table = await bootloaderResponse(lookup, bucket, "esp32s3-16mb", "2.0.7", "partition-table");
  assert.deepEqual(new Uint8Array(await table.arrayBuffer()), semverSet.files.get(semverSet.row.partition_table_key));
  const commit = await bootloaderResponse(lookup, bucket, "esp32s3-16mb", "a1b2c3d", "bootloader");
  assert.equal(commit.status, 200);
  assert.deepEqual(new Uint8Array(await commit.arrayBuffer()), commitSet.files.get(commitSet.row.bootloader_key));
  const pre = await bootloaderResponse(lookup, bucket, "esp32s3-16mb", "2.0.7-rc.1", "launcher");
  assert.equal(pre.status, 200);

  for (const [id, version, file] of [
    ["esp32s3-16mb", "2.0.8", "launcher"],
    ["esp32s3-16mb", "2.0.7", "app"],
    ["esp32s3-16mb", "2.0.7", "toString"],
    ["../secrets", "2.0.7", "launcher"],
    ["esp32s3-16mb", "latest", "launcher"],
    ["esp32s3-16mb", "deadbe", "launcher"],
    ["esp32s3-16mb", "A1B2C3D", "launcher"],
  ])
    await assert.rejects(
      bootloaderResponse(lookup, bucket, id, version, file),
      (e) => e.status === 404,
      `${id} ${version} ${file}`,
    );
  await assert.rejects(
    bootloaderResponse(lookup, fixtureBucket(new Map()), "esp32s3-16mb", "2.0.7", "bootloader"),
    (e) => e.status === 503,
  );
});
