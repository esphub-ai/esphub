import test from "node:test";
import assert from "node:assert/strict";
import {
  layoutsEqual,
  maxAppSize,
  normalizeLayout,
  parsePartitionSubtype,
  parsePartitionType,
  validLayout,
} from "../services/api/src/layout.js";
import { validate } from "../services/api/src/operations.js";
import {
  parseProjectPartitionUrl,
  signProjectPartitionUrl,
  verifyProjectPartitionSignature,
} from "../services/api/src/projects.js";

test("resize and uploads validate their different capacity limits", () => {
  const device_id = "01234567-89ab-cdef-0123-456789abcdef";
  validate("ota_resize_app", { device_id, app_size_bytes: 5 * 1048576, erase_littlefs: true });
  assert.throws(() => validate("ota_resize_app", { device_id, app_size_bytes: 4194305 }));
  validate("ota_prepare_upload", { device_id, kind: "app", size: 8 * 1048576 });
  validate("ota_prepare_upload", { device_id, kind: "partition", size: 3 * 1048576 });
  assert.throws(() => validate("ota_prepare_upload", { device_id, kind: "bootloader", size: 4194305 }));
  assert.ok(validLayout({ app_size_bytes: 5 * 1048576, data_size_bytes: 384 * 1024 }));
  assert.ok(!validLayout({ app_size_bytes: 5 * 1048576, data_size_bytes: 0 }));
});

test("extended custom tail layouts, ota_set_layout, and ota_install(kind='partition') validate cleanly", async () => {
  const device_id = "01234567-89ab-cdef-0123-456789abcdef";
  const tailOffset = 0x2a0000;
  const tailSize = 0x1000000 - tailOffset;
  const layout = {
    app_size_bytes: 7 * 1048576,
    data_size_bytes: 0,
    tail_offset: tailOffset,
    tail_size_bytes: tailSize,
    partitions: [
      { label: "app", type: 0, subtype: 0x12, offset: tailOffset, size: 7 * 1048576 },
      { label: "ui_apps", type: 1, subtype: 0x41, offset: tailOffset + 7 * 1048576, size: 3200 * 1024 },
      { label: "system", type: 1, subtype: 0x83, offset: tailOffset + 7 * 1048576 + 3200 * 1024, size: 3000 * 1024 },
    ],
  };
  assert.ok(validLayout(layout));
  assert.deepEqual(normalizeLayout({ ...layout, extra: true }), layout);
  assert.ok(layoutsEqual(layout.partitions, [...layout.partitions]));
  assert.equal(maxAppSize(layout), Math.floor((tailSize - 8192) / 65536) * 65536);

  assert.equal(parsePartitionType("app"), 0);
  assert.equal(parsePartitionType("data"), 1);
  assert.equal(parsePartitionSubtype("0x41"), 0x41);
  assert.equal(parsePartitionSubtype("littlefs"), 0x83);
  assert.equal(parsePartitionSubtype("ota_2"), 0x12);
  assert.equal(parsePartitionSubtype("nope"), null);

  validate("ota_set_layout", {
    device_id,
    erase_data: true,
    partitions: [
      { label: "app", type: "app", subtype: "ota_2", size: 7 * 1048576 },
      { label: "ui_apps", subtype: "0x41", size: 3200 * 1024 },
      { label: "system", type: "data", subtype: "littlefs", size: 3000 * 1024 },
    ],
  });
  assert.throws(() =>
    validate("ota_set_layout", {
      device_id,
      partitions: [{ label: "not_app", type: 0, subtype: 0x12, size: 1048576 }],
    }),
  );
  assert.throws(() =>
    validate("ota_set_layout", {
      device_id,
      partitions: [
        { label: "app", subtype: "ota_2", size: 1048576 },
        { label: "dup", subtype: "0x41", size: 4096 },
        { label: "dup", subtype: "littlefs", size: 4096 },
      ],
    }),
  );

  const sha = "a".repeat(64);
  const projectId = "01234567-89ab-cdef-0123-456789abcdef";
  const partUrl = `https://api.esphub.ai/projects/${projectId}/boards/espressif/esp-mosaico/releases/1.0.0/partitions/ui_apps`;
  validate("ota_install", {
    device_id,
    kind: "partition",
    label: "ui_apps",
    url: partUrl,
    sha256: sha,
  });
  assert.throws(() => validate("ota_install", { device_id, kind: "partition", url: partUrl }));
  assert.throws(() => validate("ota_install", { device_id, kind: "partition", label: "ui_apps" }));
  assert.throws(() => validate("ota_install", { device_id, kind: "app", label: "ui_apps", url: partUrl }));

  assert.deepEqual(parseProjectPartitionUrl(partUrl), {
    projectId,
    boardId: "espressif/esp-mosaico",
    version: "1.0.0",
    label: "ui_apps",
  });
  const latestPartUrl = `https://api.esphub.ai/projects/${projectId}/boards/espressif/esp-mosaico/partitions/system`;
  assert.deepEqual(parseProjectPartitionUrl(latestPartUrl), {
    projectId,
    boardId: "espressif/esp-mosaico",
    version: undefined,
    label: "system",
  });

  const secret = "test-secret-0123456789abcdef0123456789abcdef";
  const signed = await signProjectPartitionUrl(secret, {
    projectId,
    boardId: "espressif/esp-mosaico",
    version: "1.0.0",
    label: "ui_apps",
  });
  const parsed = new URL(signed);
  assert.ok(
    await verifyProjectPartitionSignature(secret, {
      projectId,
      boardId: "espressif/esp-mosaico",
      version: "1.0.0",
      label: "ui_apps",
      exp: parsed.searchParams.get("exp"),
      sig: parsed.searchParams.get("sig"),
    }),
  );
  assert.ok(
    !(await verifyProjectPartitionSignature(secret, {
      projectId,
      boardId: "espressif/esp-mosaico",
      version: "1.0.0",
      label: "system",
      exp: parsed.searchParams.get("exp"),
      sig: parsed.searchParams.get("sig"),
    })),
  );
});
