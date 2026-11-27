import test from "node:test";
import assert from "node:assert/strict";
import { validLayout } from "../services/api/src/layout.js";
import { validate } from "../services/api/src/operations.js";

test("resize and uploads validate their different capacity limits", () => {
  const device_id = "01234567-89ab-cdef-0123-456789abcdef";
  validate("ota_resize_app", { device_id, app_size_bytes: 5 * 1048576, erase_littlefs: true });
  assert.throws(() => validate("ota_resize_app", { device_id, app_size_bytes: 4194305 }));
  validate("ota_prepare_upload", { device_id, kind: "app", size: 8 * 1048576 });
  assert.throws(() => validate("ota_prepare_upload", { device_id, kind: "bootloader", size: 4194305 }));
  assert.ok(validLayout({ app_size_bytes: 5 * 1048576, data_size_bytes: 384 * 1024 }));
  assert.ok(!validLayout({ app_size_bytes: 5 * 1048576, data_size_bytes: 0 }));
});
