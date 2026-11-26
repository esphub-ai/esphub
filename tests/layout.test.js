import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { emptyLittleFS, validLayout } from "../services/api/src/layout.js";
import { validate } from "../services/api/src/operations.js";

test("empty root pairs match LittleFS lfs_format for every supported 64 KiB capacity", () => {
  // Reference: upstream lfs_format, disk 2.1, block_size=4096, prog_size=128,
  // name_max=63. Hash the first 128 bytes of blocks 0 and 1 in capacity order.
  const hash = createHash("sha256");
  for (let size = 65536; size <= 30801920; size += 65536)
    hash.update(Buffer.from(emptyLittleFS(size), "base64"));
  assert.equal(hash.digest("hex"), "13d9fda50d2472106418bc360ef6e493bc7aec99409d96770594ce3e23e7cceb");
});

test("resize and uploads validate their different capacity limits", () => {
  const device_id = "01234567-89ab-cdef-0123-456789abcdef";
  validate("ota_resize_app", { device_id, app_size_bytes: 5 * 1048576, erase_littlefs: true });
  assert.throws(() => validate("ota_resize_app", { device_id, app_size_bytes: 4194305 }));
  validate("ota_prepare_upload", { device_id, kind: "app", size: 8 * 1048576 });
  assert.throws(() => validate("ota_prepare_upload", { device_id, kind: "bootloader", size: 4194305 }));
  assert.ok(validLayout({ app_size_bytes: 5 * 1048576, data_size_bytes: 384 * 1024 }));
  assert.ok(!validLayout({ app_size_bytes: 5 * 1048576, data_size_bytes: 0 }));
});
