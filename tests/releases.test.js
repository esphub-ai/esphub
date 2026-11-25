import assert from "node:assert/strict";
import test from "node:test";
import {
  latestReleaseTag,
  releaseResponse as download,
} from "../services/api/src/releases.js";
import {
  assetNames,
  releaseVersion,
} from "../firmware-source/shared/firmware-releases.js";

const watch = {
  id: "m5stack/stopwatch",
  chip: "esp32s3",
  runtime: "micropython",
};
const mosaico = {
  id: "espressif/esp-mosaico",
  chip: "esp32s31",
  runtime: "native",
};

function releaseResponse(profile, asset, tag, releases, bucket) {
  const sql = (query, id, kind) =>
    kind ? (releases?.(query, id, kind) ?? []) : [profile];
  return download(profile.id, asset, tag, sql, bucket);
}

test("only current board-scoped downloads resolve to immutable GitHub artifacts", async () => {
  for (const [kind, tag, asset] of [
    [
      "setup-manifest",
      "firmware-setup-m5stack_stopwatch-v1.1.3",
      "esphub-m5stack_stopwatch-esp32s3-1.1.3-setup.json",
    ],
    [
      "micropython",
      "firmware-micropython-m5stack_stopwatch-v1.0.3",
      "esphub-m5stack_stopwatch-micropython-1.0.3.bin",
    ],
    [
      "ota",
      "firmware-bootloader-m5stack_stopwatch-v1.1.4",
      "esphub-m5stack_stopwatch-esp32s3-1.1.4-ota.bin",
    ],
  ]) {
    const r = await releaseResponse(watch, kind, tag);
    assert.equal(
      r.headers.get("Location"),
      `https://github.com/okou-ai/esphub/releases/download/${tag}/${asset}`,
    );
  }
  await assert.rejects(
    releaseResponse(
      { ...watch, id: "m5stack/paper-color" },
      "ota",
      "firmware-bootloader-m5stack_stopwatch-v1.1.3",
    ),
    /Unknown bootloader/,
  );
  const native = await releaseResponse(
    mosaico,
    "native",
    "firmware-native-espressif_esp-mosaico-v1.1.3",
  );
  assert.match(
    native.headers.get("Location"),
    /esphub-espressif_esp-mosaico-native-1\.1\.3\.bin$/,
  );
  await assert.rejects(
    releaseResponse(
      mosaico,
      "micropython",
      "firmware-micropython-espressif_esp-mosaico-v1.1.3",
    ),
    /Unknown download/,
  );
});

test("default downloads and OTA use the board's published release tag", async (t) => {
  const tag = "firmware-bootloader-m5stack_stopwatch-v1.1.133";
  const sql = async (_query, board, kind) => {
    assert.equal(board, "m5stack/stopwatch");
    return kind === "bootloader" ? [{ version: "1.1.133" }] : [];
  };
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("unexpected network request"),
  );
  assert.equal(
    await latestReleaseTag(sql, "m5stack/stopwatch", "bootloader"),
    tag,
  );
  const ota = await releaseResponse(watch, "ota", undefined, sql);
  assert.equal(
    ota.headers.get("Location"),
    `https://github.com/okou-ai/esphub/releases/download/${tag}/esphub-m5stack_stopwatch-esp32s3-1.1.133-ota.bin`,
  );
  await assert.rejects(
    releaseResponse(watch, "setup", undefined, sql),
    (e) => e.status === 404,
  );
});

test("R2 serves only completed versioned releases and preserves legacy redirects", async () => {
  const tag = "firmware-bootloader-m5stack_stopwatch-v1.2.1";
  const filename = "esphub-m5stack_stopwatch-esp32s3-1.2.1-ota.bin";
  const object = {
    size: 3,
    body: new Uint8Array([1, 2, 3]),
    httpEtag: '"test"',
    writeHttpMetadata(headers) {
      headers.set("Content-Type", "application/octet-stream");
    },
  };
  let published = false;
  let asset = object;
  const bucket = {
    async get(key) {
      if (key === `releases/${tag}/published.json`)
        return published
          ? { json: async () => ({ assets: [{ name: filename }] }) }
          : null;
      assert.equal(key, `releases/${tag}/${filename}`);
      return asset;
    },
  };
  const legacy = await releaseResponse(watch, "ota", tag, undefined, bucket);
  assert.match(legacy.headers.get("Location"), /github\.com/);
  published = true;
  const pinned = await download(watch.id, "ota", tag, undefined, bucket);
  assert.deepEqual(
    Array.from(new Uint8Array(await pinned.arrayBuffer())),
    [1, 2, 3],
  );
  assert.match(pinned.headers.get("Cache-Control"), /immutable/);
  const latest = await releaseResponse(
    watch,
    "ota",
    undefined,
    async () => [{ version: "1.2.1" }],
    bucket,
  );
  assert.match(latest.headers.get("Cache-Control"), /must-revalidate/);
  asset = null;
  await assert.rejects(
    releaseResponse(watch, "ota", tag, undefined, bucket),
    (error) => error.status === 503,
  );
});

test("migrated setup manifests point at the pinned EspHub download", async () => {
  const tag = "firmware-setup-m5stack_stopwatch-v1.1.231";
  const manifest = {
    board: "m5stack/stopwatch",
    version: "1.1.231",
    sha256: "a".repeat(64),
    download_url:
      "https://github.com/okou-ai/esphub/releases/download/legacy/setup.zip",
  };
  const bucket = {
    async get(key) {
      if (key.endsWith("/published.json")) return { json: async () => ({}) };
      return {
        async json() {
          return manifest;
        },
        writeHttpMetadata(headers) {
          headers.set("Content-Type", "application/json");
        },
      };
    },
  };
  const response = await releaseResponse(
    watch,
    "setup-manifest",
    tag,
    undefined,
    bucket,
  );
  assert.deepEqual(await response.json(), {
    ...manifest,
    download_url:
      "https://api.esphub.ai/releases/m5stack/stopwatch/setup?tag=" + tag,
  });
});
