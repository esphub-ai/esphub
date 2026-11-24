import assert from "node:assert/strict";
import test from "node:test";
import { softwareInventory } from "../services/api/src/software.js";

test("native apps share the Python OTA slot but display their own SDK and IDF", () => {
  const app = {
    role: "app",
    boot_id: "current",
    image_profile: "ESPHUB2/micropython/stopwatch",
    fw: { name: "coffee_watch_demo", version: "v0.1.21", idf: "v5.5.2" },
  };
  const old = { role: "bootloader", fw: { version: "1.0.12" } };
  const result = softwareInventory(app, old);
  assert.equal(result.bootloader_version, "1.0.12");
  assert.equal(result.bootloader_last_seen, true);
  assert.equal(result.application.kind, "native");
  assert.equal(result.application.sdk_version, null);
  assert.equal(result.application.esp_idf_version, "v5.5.2");
  assert.equal(
    softwareInventory({ ...app, bootloader_version: "2", sdk_version: "1" }, old)
      .bootloader_version,
    "2",
  );
  assert.equal(softwareInventory(old, app).application.last_seen, true);
  assert.equal(softwareInventory(null).application, null);
});

test("minimal app hello uses the launcher version from the previous boot", () => {
  const app = { role: "app", runtime_type: "micropython", runtime_version: "1.2.4" };
  const launcher = { role: "bootloader", bootloader_version: "1.2.3" };
  const result = softwareInventory(app, launcher);
  assert.equal(result.bootloader_version, "1.2.3");
  assert.equal(result.application.kind, "micropython");
  assert.equal(result.application.runtime_version, "1.2.4");
});
