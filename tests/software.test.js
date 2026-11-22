import assert from "node:assert/strict";
import test from "node:test";
import { softwareInventory } from "../services/api/src/software.js";

test("native apps share the Python OTA slot but display their own SDK and IDF", () => {
  const app = {
    role: "app",
    boot_id: "current",
    image_profile: "ESPHUB1/micropython/stopwatch",
    fw: { name: "coffee_watch_demo", version: "v0.1.21", idf: "v5.5.2" },
  };
  const old = { role: "launcher", fw: { version: "1.0.12" } };
  const result = softwareInventory(app, old);
  assert.equal(result.launcher_version, "1.0.12");
  assert.equal(result.launcher_last_seen, true);
  assert.equal(result.application.kind, "native");
  assert.equal(result.application.sdk_version, null);
  assert.equal(result.application.esp_idf_version, "v5.5.2");
  assert.equal(
    softwareInventory({ ...app, launcher_version: "2", sdk_version: "1" }, old)
      .launcher_version,
    "2",
  );
  assert.equal(softwareInventory(old, app).application.last_seen, true);
  assert.equal(softwareInventory(null).application, null);
});
