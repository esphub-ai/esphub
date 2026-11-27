import { createHash } from "node:crypto";

// Firmware as the publisher records it: bootloader sets shared by boards.
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = (seed, length) => new Uint8Array(length).fill(seed);
const chipOf = (id) => id.split("-")[0];
const bootloaderOffset = { esp32: 0x1000, esp32s3: 0 };

export function bootloaderSet(id, version = "2.0.7") {
  const files = new Map();
  const put = (name, body) => {
    const key = `fixture/bootloaders/${id}/${version}/${name}`;
    files.set(key, body);
    return { key, sha256: sha256(body) };
  };
  const loader = put("bootloader.bin", bytes(1, 64));
  const table = put("partition-table.bin", bytes(2, 32));
  const launcher = put("launcher.bin", bytes(3, 128));
  const row = {
    id, version, chip: chipOf(id),
    flash_mode: "dio", flash_size: (id.match(/-(\d+)mb/)?.[1] ?? "16") + "MB", flash_freq: "80m",
    bootloader_offset: bootloaderOffset[chipOf(id)] ?? 0x2000,
    bootloader_key: loader.key, bootloader_size: 64, bootloader_sha256: loader.sha256,
    partition_table_offset: 0x8000, partition_table_key: table.key, partition_table_size: 32, partition_table_sha256: table.sha256,
    launcher_offset: 0x20000, launcher_key: launcher.key, launcher_sha256: launcher.sha256, launcher_size: 128,
    app_offset: 0x2a0000, nvs_offset: 0x9000, nvs_size: 0x6000,
  };
  return { row, files };
}

export async function recordFirmware(sql, { row }) {
  if (row) {
    await sql`INSERT INTO esphub.bootloaders ${sql(row)} ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO esphub.bootloader_releases (id, version) VALUES (${row.id}, ${row.version})
      ON CONFLICT (id) DO UPDATE SET version = excluded.version, promoted_at = now()`;
  }
}

// An R2 bucket stand-in. Published objects carry their sha256 as custom metadata.
export function fixtureBucket(files, metadata = new Map()) {
  const object = (key) => {
    const body = files.get(key);
    return body && {
      size: body.length, body, httpEtag: `"${sha256(body).slice(0, 16)}"`,
      customMetadata: metadata.get(key) ?? { sha256: sha256(body) },
      writeHttpMetadata() {},
    };
  };
  return {
    async get(key) { return object(key) ?? null; },
    async head(key) { return object(key) ?? null; },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        files.delete(key);
        metadata.delete(key);
      }
    },
  };
}
