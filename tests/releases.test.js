import assert from "node:assert/strict";
import test from "node:test";
import { assetNames, releaseTag } from "../firmware-source/shared/firmware-releases.js";
import { publishedAsset, releaseResponse } from "../services/api/src/releases.js";

const board = "m5stack/stopwatch", version = "2.0.3";
test("published assets resolve by board, version and kind; latest downloads revalidate", async () => {
  for (const [kind, asset] of [["bootloader", "ota"], ["setup", "setup"], ["app", "app"]]) {
    const tag = releaseTag(kind, board, version);
    const name = assetNames(board, "esp32s3", kind, version)[asset];
    const data = Uint8Array.of(1, 2, 3);
    let published = false, available = true;
    const bucket = { async get(key) {
      if (key === `releases/${tag}/published.json`)
        return published ? { json: async () => ({ assets: [{ name, size: data.length }] }) } : null;
      assert.equal(key, `releases/${tag}/${name}`);
      return available ? { size: 3, body: data, httpEtag: '"test"', writeHttpMetadata() {} } : null;
    } };
    const sql = async (_query, id, selectedKind) => {
      assert.equal(id, board);
      assert.equal(selectedKind, kind);
      return [{ version }];
    };
    const get = (where, tag) => releaseResponse(where, asset, tag, sql, bucket);
    await assert.rejects(get(board, tag), e => e.status === 404);
    published = true;
    assert.deepEqual(await publishedAsset(board, kind, asset, tag, bucket), { key: `releases/${tag}/${name}`, size: data.length });
    const pinned = await get(board, tag);
    assert.match(pinned.headers.get("Cache-Control"), /immutable/);
    assert.deepEqual(new Uint8Array(await pinned.arrayBuffer()), data);
    assert.match((await get(board)).headers.get("Cache-Control"), /must-revalidate/);
    await assert.rejects(get("m5stack/core2", tag), e => e.status === 404);
    available = false;
    await assert.rejects(get(board, tag), e => e.status === 503);
  }
});
