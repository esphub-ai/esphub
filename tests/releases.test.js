import assert from "node:assert/strict";
import test from "node:test";
import {
  latestReleaseTag,
  releaseResponse,
} from "../services/api/src/releases.js";
import { assetNames, releaseVersion } from "../shared/firmware-releases.js";

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
    const r = await releaseResponse("m5stack/stopwatch", kind, tag);
    assert.equal(
      r.headers.get("Location"),
      `https://github.com/okou-ai/esphub/releases/download/${tag}/${asset}`,
    );
  }
  await assert.rejects(
    releaseResponse(
      "m5stack/paper-color",
      "ota",
      "firmware-bootloader-m5stack_stopwatch-v1.1.3",
    ),
    /Unknown bootloader/,
  );
  const native = await releaseResponse(
    "espressif/esp-mosaico",
    "native",
    "firmware-native-espressif_esp-mosaico-v1.1.3",
  );
  assert.match(
    native.headers.get("Location"),
    /esphub-espressif_esp-mosaico-native-1\.1\.3\.bin$/,
  );
  await assert.rejects(
    releaseResponse("espressif/esp-mosaico", "micropython", undefined),
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
  const ota = await releaseResponse("m5stack/stopwatch", "ota", undefined, sql);
  assert.equal(
    ota.headers.get("Location"),
    `https://github.com/okou-ai/esphub/releases/download/${tag}/esphub-m5stack_stopwatch-esp32s3-1.1.133-ota.bin`,
  );
  await assert.rejects(
    releaseResponse("m5stack/stopwatch", "setup", undefined, sql),
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
    async head(key) {
      assert.equal(key, `releases/${tag}/published.json`);
      return published ? {} : null;
    },
    async get(key) {
      assert.equal(key, `releases/${tag}/${filename}`);
      return asset;
    },
  };
  const legacy = await releaseResponse(
    "m5stack/stopwatch",
    "ota",
    tag,
    undefined,
    bucket,
  );
  assert.match(legacy.headers.get("Location"), /github\.com/);
  published = true;
  const pinned = await releaseResponse(
    "m5stack/stopwatch",
    "ota",
    tag,
    undefined,
    bucket,
  );
  assert.deepEqual(
    Array.from(new Uint8Array(await pinned.arrayBuffer())),
    [1, 2, 3],
  );
  assert.match(pinned.headers.get("Cache-Control"), /immutable/);
  const latest = await releaseResponse(
    "m5stack/stopwatch",
    "ota",
    undefined,
    async () => [{ version: "1.2.1" }],
    bucket,
  );
  assert.match(latest.headers.get("Cache-Control"), /must-revalidate/);
  asset = null;
  await assert.rejects(
    releaseResponse("m5stack/stopwatch", "ota", tag, undefined, bucket),
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
    async head() {
      return {};
    },
    async get() {
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
    "m5stack/stopwatch",
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
