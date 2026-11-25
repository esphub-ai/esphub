import assert from "node:assert/strict";
import test from "node:test";
import {
  latestReleaseTag,
  releaseResponse,
} from "../services/api/src/releases.js";
import {
  assetNames,
  publishedFirmware,
  releaseVersion,
} from "../shared/firmware-releases.js";

test("the latest version is selected independently by board and component across pages", async () => {
  const boards = {
    "waveshare/stopwatch": { chip: "esp32s3" },
    "m5stack/stopwatch": { chip: "esp32s3" },
  };
  const release = (tag, targets, kind, version) => ({
    tag_name: tag,
    assets: targets.flatMap((id) =>
      Object.values(assetNames(id, "esp32s3", kind, version)).map((name) => ({
        name,
        state: "uploaded",
      })),
    ),
  });
  const newest = release(
    "firmware-bootloader-m5stack_stopwatch-v1.1.12",
    ["m5stack/stopwatch"],
    "bootloader",
    "1.1.12",
  );
  const otherGroup = release(
    "firmware-bootloader-waveshare_stopwatch-v1.1.5",
    ["waveshare/stopwatch"],
    "bootloader",
    "1.1.5",
  );
  const pages = [
    [
      release(
        "firmware-bootloader-m5stack_stopwatch-v1.1.9",
        ["m5stack/stopwatch"],
        "bootloader",
        "1.1.9",
      ),
      release(
        "firmware-setup-m5stack_stopwatch-v1.0.1",
        ["m5stack/stopwatch"],
        "setup",
        "1.0.1",
      ),
    ],
    [
      newest,
      otherGroup,
      {
        ...newest,
        tag_name: "firmware-bootloader-waveshare_stopwatch-v1.1.12",
      },
      {
        ...newest,
        draft: true,
        tag_name: "firmware-bootloader-m5stack_stopwatch-v2.0.0",
      },
    ],
  ];
  const catalog = await publishedFirmware(boards, async () => {
    const page = pages.shift();
    return Response.json(page, {
      headers: pages.length ? { Link: '<some-url>; rel="next"' } : {},
    });
  });
  assert.equal(catalog["m5stack/stopwatch"].bootloader.tag, newest.tag_name);
  assert.equal(
    catalog["waveshare/stopwatch"].bootloader.tag,
    otherGroup.tag_name,
  );
  assert.equal(catalog["m5stack/stopwatch"].setup.version, "1.0.1");
  assert.equal(
    releaseVersion(newest.tag_name, "bootloader", "waveshare/stopwatch"),
    null,
  );
});

test("a fork checks its own published components", async () => {
  const request = async (url) => {
    assert.equal(
      new URL(url).pathname,
      "/repos/firmware-user/custom-boards/releases",
    );
    return Response.json([]);
  };
  const releases = await publishedFirmware(
    { "m5stack/stopwatch": { chip: "esp32s3" } },
    request,
    undefined,
    "firmware-user/custom-boards",
  );
  assert.deepEqual(releases, { "m5stack/stopwatch": {} });
});

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
