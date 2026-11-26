import assert from "node:assert/strict";
import test from "node:test";
import { releaseFile, releaseResponse } from "../services/api/src/releases.js";
import { releaseUrl } from "../shared/identity.js";

const board = "m5stack/stopwatch";
// Tags and object keys are opaque publisher records, so they need no particular naming.
const index = [
  { tag: "app-one", asset: "app", board, kind: "app", object_key: "objects/app-one.bin", size: "3" },
  { tag: "app-two", asset: "app", board, kind: "app", object_key: "objects/app-two.bin", size: null },
  { tag: "boot-one", asset: "ota", board, kind: "bootloader", object_key: "objects/boot-one-ota.bin", size: "2" },
  { tag: "kit-one", asset: "setup", board, kind: "setup", object_key: "objects/kit-one.zip", size: "1" },
  { tag: "kit-one", asset: "setup-manifest", board, kind: "setup", object_key: "objects/kit-one.json", size: "40" },
];
const latest = { app: "app-two", bootloader: "boot-one", setup: "kit-one" };

// Mirrors the two release queries: the latest release joins firmware_releases.
const sql = async (strings, ...values) => {
  const [where, asset, tag] = values;
  const isLatest = strings.join("?").includes("esphub.firmware_releases");
  return index.filter((row) => row.board === where && row.asset === asset &&
    (isLatest ? latest[row.kind] === row.tag : row.tag === tag));
};

function bucketWith(objects) {
  return { async get(key) {
    if (!objects.has(key)) return null;
    const body = objects.get(key);
    return {
      size: body.length, body, httpEtag: '"test"', writeHttpMetadata() {},
      json: async () => JSON.parse(new TextDecoder().decode(body)),
    };
  } };
}

test("files resolve from the publisher's index and latest downloads revalidate", async () => {
  const objects = new Map([
    ["objects/app-one.bin", Uint8Array.of(1, 1, 1)],
    ["objects/app-two.bin", Uint8Array.of(2, 2)],
  ]);
  const bucket = bucketWith(objects);
  const get = (where, asset, tag) => releaseResponse(where, asset, tag, sql, bucket);

  const pinned = await get(board, "app", "app-one");
  assert.match(pinned.headers.get("Cache-Control"), /immutable/);
  assert.deepEqual(new Uint8Array(await pinned.arrayBuffer()), Uint8Array.of(1, 1, 1));
  const current = await get(board, "app");
  assert.match(current.headers.get("Cache-Control"), /must-revalidate/);
  assert.deepEqual(new Uint8Array(await current.arrayBuffer()), Uint8Array.of(2, 2));

  assert.deepEqual(await releaseFile(sql, board, "app", "app-one"),
    { tag: "app-one", asset: "app", board, kind: "app", object_key: "objects/app-one.bin", size: 3 });
  assert.equal((await releaseFile(sql, board, "app")).size, null);
  assert.equal((await releaseFile(sql, board, "ota")).tag, "boot-one");

  for (const [where, asset, tag] of [
    ["m5stack/core2", "app", "app-one"], // another board's download
    [board, "ota", "app-one"], // a tag of another kind
    [board, "app", "app-three"],
    [board, "firmware", undefined],
    ["../secrets", "app", undefined],
  ])
    await assert.rejects(get(where, asset, tag), (e) => e.status === 404, `${where} ${asset} ${tag}`);
  objects.delete("objects/app-one.bin");
  await assert.rejects(get(board, "app", "app-one"), (e) => e.status === 503);
});

test("a setup manifest links to the setup kit of the same release", async () => {
  const manifest = { tag: "kit-one", board, version: "2.0.7" };
  const bucket = bucketWith(new Map([
    ["objects/kit-one.json", new TextEncoder().encode(JSON.stringify(manifest))],
  ]));
  for (const tag of [undefined, "kit-one"]) {
    const response = await releaseResponse(board, "setup-manifest", tag, sql, bucket);
    assert.match(response.headers.get("Cache-Control"), /must-revalidate/);
    assert.deepEqual(await response.json(),
      { ...manifest, download_url: releaseUrl(board, "setup", "kit-one") });
  }
});
