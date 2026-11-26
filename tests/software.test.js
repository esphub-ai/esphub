import assert from "node:assert/strict";
import test from "node:test";
import { softwareInventory } from "../services/api/src/software.js";

test("device inventory identifies the running app and the previous maintenance session", () => {
  const app = { role: "app", fw: { name: "bar-graph", version: "2.0.4" }, sdk_version: "8.0.0" };
  const boot = { role: "bootloader", bootloader_version: "2.0.3" };
  assert.deepEqual(softwareInventory(app, boot), {
    bootloader_version: "2.0.3", bootloader_last_seen: true,
    application: { ...app.fw, sdk_version: "8.0.0", last_seen: false },
  });
  assert.equal(softwareInventory(boot, app).application.last_seen, true);
  assert.equal(softwareInventory(boot).application, null);
});
