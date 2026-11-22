import assert from "node:assert/strict";
import test from "node:test";
import { releaseResponse } from "../services/api/src/releases.js";
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
    "launcher-stopwatch-v1.1.12",
    ["stopwatch"],
    "launcher",
    "1.1.12",
  );
  const pages = [
    [
      release("launcher-stopwatch-v1.1.9", ["stopwatch"], "launcher", "1.1.9"),
      release("setup-v1.0.1", Object.keys(boards), "setup", "1.0.1"),
    ],
    [
      newest,
      { ...newest, tag_name: "launcher-paper-color-v1.1.12" },
      release("launcher-v1.0.11", Object.keys(boards), "launcher", "1.0.11"),
      { ...newest, draft: true, tag_name: "launcher-stopwatch-v2.0.0" },
    ],
  ];
  const catalog = await publishedFirmware(boards, async () => {
    const page = pages.shift();
    return Response.json(page, {
      headers: pages.length ? { Link: '<some-url>; rel="next"' } : {},
    });
  });
  assert.equal(catalog.stopwatch.launcher.tag, newest.tag_name);
  assert.equal(catalog["paper-color"].launcher.tag, "launcher-v1.0.11");
  assert.equal(catalog.stopwatch.setup.tag, "setup-v1.0.1");
  assert.equal(
    releaseVersion(newest.tag_name, "launcher", "paper-color"),
    null,
  );
});

test("pinned old and board-scoped downloads resolve to immutable GitHub artifacts", async () => {
  for (const [kind, tag, asset] of [
    ["setup", "setup-v1.0.1", "esphub-stopwatch-esp32s3-1.0.1-setup.zip"],
    [
      "setup-manifest",
      "setup-stopwatch-v1.1.3",
      "esphub-stopwatch-esp32s3-1.1.3-setup.json",
    ],
    [
      "micropython",
      "micropython-v1.0.3",
      "esphub-stopwatch-micropython-1.0.3.bin",
    ],
    [
      "ota",
      "launcher-stopwatch-v1.1.4",
      "esphub-stopwatch-esp32s3-1.1.4-ota.bin",
    ],
  ]) {
    const r = await releaseResponse("stopwatch", kind, tag, false);
    assert.equal(
      r.headers.get("Location"),
      `https://github.com/okou-ai/esphub/releases/download/${tag}/${asset}`,
    );
  }
  await assert.rejects(
    releaseResponse("paper-color", "ota", "launcher-stopwatch-v1.1.3", false),
    /Unknown launcher/,
  );
  await assert.rejects(
    releaseResponse("stopwatch", "setup", "launcher-v1.0.1", false),
    /Unknown setup/,
  );
});
