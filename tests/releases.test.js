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
    "paper-color": { chip: "esp32s3" },
    stopwatch: { chip: "esp32s3" },
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
    "firmware-bootloader-stopwatch-v1.1.12",
    ["stopwatch"],
    "bootloader",
    "1.1.12",
  );
  const pages = [
    [
      release(
        "firmware-bootloader-stopwatch-v1.1.9",
        ["stopwatch"],
        "bootloader",
        "1.1.9",
      ),
      release("setup-v1.0.1", Object.keys(boards), "setup", "1.0.1"),
    ],
    [
      newest,
      { ...newest, tag_name: "firmware-bootloader-paper-color-v1.1.12" },
      release(
        "bootloader-v1.0.11",
        Object.keys(boards),
        "bootloader",
        "1.0.11",
      ),
      {
        ...newest,
        draft: true,
        tag_name: "firmware-bootloader-stopwatch-v2.0.0",
      },
    ],
  ];
  const catalog = await publishedFirmware(boards, async () => {
    const page = pages.shift();
    return Response.json(page, {
      headers: pages.length ? { Link: '<some-url>; rel="next"' } : {},
    });
  });
  assert.equal(catalog.stopwatch.bootloader.tag, newest.tag_name);
  assert.equal(catalog["paper-color"].bootloader, undefined);
  assert.equal(catalog.stopwatch.setup, undefined);
  assert.equal(
    releaseVersion(newest.tag_name, "bootloader", "paper-color"),
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
    { stopwatch: { chip: "esp32s3" } },
    request,
    undefined,
    "firmware-user/custom-boards",
  );
  assert.deepEqual(releases, { stopwatch: {} });
});

test("only current board-scoped downloads resolve to immutable GitHub artifacts", async () => {
  for (const [kind, tag, asset] of [
    [
      "setup-manifest",
      "firmware-setup-stopwatch-v1.1.3",
      "esphub-stopwatch-esp32s3-1.1.3-setup.json",
    ],
    [
      "micropython",
      "firmware-micropython-stopwatch-v1.0.3",
      "esphub-stopwatch-micropython-1.0.3.bin",
    ],
    [
      "ota",
      "firmware-bootloader-stopwatch-v1.1.4",
      "esphub-stopwatch-esp32s3-1.1.4-ota.bin",
    ],
  ]) {
    const r = await releaseResponse("stopwatch", kind, tag);
    assert.equal(
      r.headers.get("Location"),
      `https://github.com/okou-ai/esphub/releases/download/${tag}/${asset}`,
    );
  }
  await assert.rejects(
    releaseResponse(
      "paper-color",
      "ota",
      "firmware-bootloader-stopwatch-v1.1.3",
    ),
    /Unknown bootloader/,
  );
  const native = await releaseResponse(
    "esp-mosaico",
    "native",
    "firmware-native-esp-mosaico-v1.1.3",
  );
  assert.match(
    native.headers.get("Location"),
    /esphub-esp-mosaico-native-1\.1\.3\.bin$/,
  );
  await assert.rejects(
    releaseResponse("esp-mosaico", "micropython", undefined),
    /Unknown download/,
  );
});

test("default downloads and OTA use the board's published release tag", async (t) => {
  const tag = "firmware-bootloader-stopwatch-v1.1.133";
  const sql = async (_query, board, kind) => {
    assert.equal(board, "stopwatch");
    return kind === "bootloader" ? [{ version: "1.1.133" }] : [];
  };
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("unexpected network request"),
  );
  assert.equal(await latestReleaseTag(sql, "stopwatch", "bootloader"), tag);
  const ota = await releaseResponse("stopwatch", "ota", undefined, sql);
  assert.equal(
    ota.headers.get("Location"),
    `https://github.com/okou-ai/esphub/releases/download/${tag}/esphub-stopwatch-esp32s3-1.1.133-ota.bin`,
  );
  await assert.rejects(
    releaseResponse("stopwatch", "setup", undefined, sql),
    (e) => e.status === 404,
  );
});
