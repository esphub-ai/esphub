import assert from "node:assert/strict";
import test from "node:test";
import setup from "../shared/setup-release.json" with { type: "json" };
import { releaseResponse } from "../services/api/src/releases.js";

test("USB setup links follow the selected kit independently of launcher updates", async () => {
  for (const board of ["paper-color", "stopwatch"]) {
    const result = await releaseResponse(board, "setup", undefined, false);
    assert.equal(result.status, 302);
    assert.equal(
      result.headers.get("Location"),
      `https://github.com/okou-ai/esphub/releases/download/setup-v${setup.version}/esphub-${board}-esp32s3-${setup.version}-setup.zip`,
    );
    const old = await releaseResponse(
      board,
      "setup-manifest",
      "setup-v0.9.4",
      false,
    );
    assert.ok(
      old.headers
        .get("Location")
        .endsWith(`/setup-v0.9.4/esphub-${board}-esp32s3-0.9.4-setup.json`),
    );
    await assert.rejects(
      releaseResponse(board, "setup", "launcher-v1.0.1", false),
      /Unknown USB setup kit/,
    );
  }
});
