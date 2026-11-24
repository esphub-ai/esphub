import assert from "node:assert/strict";
import test from "node:test";
import { softwareInventory } from "../services/api/src/software.js";

test("legacy firmware diagnostics do not populate the software inventory", () => {
  const app = { role: "app", fw: { name: "micropython", version: "1.2.4" } };
  const launcher = { role: "bootloader", fw: { version: "1.2.3" } };
  assert.deepEqual(softwareInventory(app, launcher), {
    bootloader_version: null,
    bootloader_last_seen: false,
    application: null,
  });
});

test("minimal app hello uses the launcher version from the previous boot", () => {
  const app = { role: "app", runtime_type: "micropython", runtime_version: "1.2.4" };
  const launcher = { role: "bootloader", bootloader_version: "1.2.3" };
  const result = softwareInventory(app, launcher);
  assert.equal(result.bootloader_version, "1.2.3");
  assert.equal(result.application.kind, "micropython");
  assert.equal(result.application.runtime_version, "1.2.4");
});
