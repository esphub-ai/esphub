// Internal bootloader publishing: presigned R2 staging uploads, server-side
// staging-to-immutable moves, and single-row release promotion.
import { bootloaderUrl } from "../../../shared/identity.js";
import { fail } from "./auth.js";
import { bootloaderIdPattern, versionPattern } from "./firmware.js";
import { uuidPattern } from "./ids.js";
import {
  copyStagedObject,
  r2Config,
  signPresignedPut,
  stagingKey,
  uploadExpirySeconds,
} from "./r2.js";

const maxUploads = 50;
const maxInt32 = 2147483647;
const sha256Pattern = /^[0-9a-f]{64}$/;
const flashTokenPattern = /^[A-Za-z0-9._-]{1,32}$/;

const fileSpecs = [
  { key: "bootloader", column: "bootloader", filename: "bootloader.bin", download: "bootloader" },
  {
    key: "partition_table",
    column: "partition_table",
    filename: "partition-table.bin",
    download: "partition-table",
  },
  { key: "launcher", column: "launcher", filename: "launcher.bin", download: "launcher" },
];

const topLevelKeys = new Set([
  "id",
  "version",
  "chip",
  "flash_mode",
  "flash_size",
  "flash_freq",
  "app_offset",
  "nvs_offset",
  "nvs_size",
  "files",
]);
const fileEntryKeys = new Set(["upload_id", "offset", "size", "sha256"]);

export { stagingKey };
export const bootloaderObjectKey = (id, version, filename) =>
  `bootloaders/${id}/${version}/${filename}`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertInt32(value, name, min = 0) {
  if (!Number.isInteger(value) || value < min || value > maxInt32)
    fail(400, `Invalid ${name}`);
  return value;
}

export async function createInternalUploads(env, input) {
  if (!isPlainObject(input)) fail(400, "Expected an upload request object");
  for (const key of Object.keys(input))
    if (key !== "count") fail(400, "Unexpected " + key);
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > maxUploads)
    fail(400, `count must be an integer between 1 and ${maxUploads}`);

  const s3 = r2Config(env);
  const expiresAt = new Date(Date.now() + uploadExpirySeconds * 1000).toISOString();
  const uploads = await Promise.all(
    Array.from({ length: input.count }, async () => {
      const id = crypto.randomUUID();
      const url = await signPresignedPut(s3, {
        key: stagingKey(id),
        expiresSeconds: uploadExpirySeconds,
      });
      return {
        id,
        method: "PUT",
        url,
        headers: { "Content-Type": "application/octet-stream" },
        expires_at: expiresAt,
      };
    }),
  );
  return { uploads };
}

export function parseBootloaderPayload(input) {
  if (!isPlainObject(input)) fail(400, "Expected a bootloader request object");
  for (const key of Object.keys(input))
    if (!topLevelKeys.has(key)) fail(400, "Unexpected " + key);

  const { id, version, chip } = input;
  if (typeof id !== "string" || !bootloaderIdPattern.test(id))
    fail(400, "Invalid id");
  if (typeof version !== "string" || !versionPattern.test(version))
    fail(400, "Invalid version");
  if (typeof chip !== "string" || chip !== id.split("-", 1)[0])
    fail(400, "Invalid chip");

  for (const field of ["flash_mode", "flash_size", "flash_freq"]) {
    if (typeof input[field] !== "string" || !flashTokenPattern.test(input[field]))
      fail(400, `Invalid ${field}`);
  }

  const app_offset = assertInt32(input.app_offset, "app_offset", 0);
  const nvs_offset = assertInt32(input.nvs_offset, "nvs_offset", 0);
  const nvs_size = assertInt32(input.nvs_size, "nvs_size", 1);

  if (!isPlainObject(input.files)) fail(400, "Missing files");
  const expectedFiles = new Set(fileSpecs.map((s) => s.key));
  for (const key of Object.keys(input.files))
    if (!expectedFiles.has(key)) fail(400, `Unexpected file ${key}`);

  const row = {
    id,
    version,
    chip,
    flash_mode: input.flash_mode,
    flash_size: input.flash_size,
    flash_freq: input.flash_freq,
    app_offset,
    nvs_offset,
    nvs_size,
  };
  const uploadIds = new Set();
  for (const spec of fileSpecs) {
    const entry = input.files[spec.key];
    if (!isPlainObject(entry)) fail(400, `Missing files.${spec.key}`);
    for (const k of Object.keys(entry))
      if (!fileEntryKeys.has(k)) fail(400, `Unexpected files.${spec.key}.${k}`);
    if (typeof entry.upload_id !== "string" || !uuidPattern.test(entry.upload_id))
      fail(400, `Invalid files.${spec.key}.upload_id`);
    if (uploadIds.has(entry.upload_id))
      fail(400, "Duplicate upload_id across files");
    uploadIds.add(entry.upload_id);
    if (typeof entry.sha256 !== "string" || !sha256Pattern.test(entry.sha256))
      fail(400, `Invalid files.${spec.key}.sha256`);

    row[`${spec.column}_upload_id`] = entry.upload_id;
    row[`${spec.column}_offset`] = assertInt32(entry.offset, `files.${spec.key}.offset`, 0);
    row[`${spec.column}_size`] = assertInt32(entry.size, `files.${spec.key}.size`, 1);
    row[`${spec.column}_sha256`] = entry.sha256;
    row[`${spec.column}_key`] = bootloaderObjectKey(id, version, spec.filename);
  }

  if (!(nvs_offset < row.launcher_offset && row.launcher_offset < app_offset))
    fail(400, "Unexpected partition layout");

  return row;
}

function rowsMatch(existing, candidate) {
  const exactFields = [
    "chip",
    "flash_mode",
    "flash_size",
    "flash_freq",
    "app_offset",
    "nvs_offset",
    "nvs_size",
    "bootloader_offset",
    "bootloader_key",
    "bootloader_sha256",
    "partition_table_offset",
    "partition_table_key",
    "partition_table_sha256",
    "launcher_offset",
    "launcher_key",
    "launcher_sha256",
    "launcher_size",
  ];
  for (const field of exactFields) {
    if (String(existing[field]) !== String(candidate[field])) return false;
  }
  for (const field of ["bootloader_size", "partition_table_size"]) {
    if (
      existing[field] !== null &&
      existing[field] !== undefined &&
      String(existing[field]) !== String(candidate[field])
    )
      return false;
  }
  return true;
}

export function formatBootloaderRecord(row) {
  const files = {};
  for (const spec of fileSpecs) {
    const size = row[`${spec.column}_size`];
    files[spec.key] = {
      upload_id: row[`${spec.column}_upload_id`] ?? null,
      key: row[`${spec.column}_key`],
      offset: Number(row[`${spec.column}_offset`]),
      size: size === null || size === undefined ? null : Number(size),
      sha256: row[`${spec.column}_sha256`],
      url: bootloaderUrl(row.id, row.version, spec.download),
    };
  }
  return {
    id: row.id,
    version: row.version,
    chip: row.chip,
    flash_mode: row.flash_mode,
    flash_size: row.flash_size,
    flash_freq: row.flash_freq,
    app_offset: Number(row.app_offset),
    nvs_offset: Number(row.nvs_offset),
    nvs_size: Number(row.nvs_size),
    files,
  };
}

export async function createBootloaderVersion(env, sql, input) {
  const row = parseBootloaderPayload(input);

  const [existing] =
    await sql`SELECT * FROM esphub.bootloaders WHERE id = ${row.id} AND version = ${row.version}`;
  if (existing) {
    if (rowsMatch(existing, row))
      return { status: 200, body: formatBootloaderRecord(existing) };
    fail(409, "Bootloader version already exists with different content");
  }

  const s3 = r2Config(env);

  // Header-only check on the three staged objects (never stream bodies through the Worker).
  const staged = await Promise.all(
    fileSpecs.map(async (spec) => {
      const srcKey = stagingKey(row[`${spec.column}_upload_id`]);
      const object = await env.FIRMWARE.head(srcKey);
      if (!object) fail(400, `Staging upload not found: ${spec.key}`);
      if (object.size !== row[`${spec.column}_size`])
        fail(400, `Staging upload size mismatch: ${spec.key}`);
      return { spec, srcKey };
    }),
  );

  // Server-side R2 CopyObject into the immutable bootloader path.
  await Promise.all(
    staged.map(({ spec, srcKey }) =>
      copyStagedObject(env, s3, {
        label: spec.key,
        srcKey,
        destKey: row[`${spec.column}_key`],
        contentType: "application/octet-stream",
        expectedSize: row[`${spec.column}_size`],
        expectedSha: row[`${spec.column}_sha256`],
      }),
    ),
  );

  const [inserted] = await sql`INSERT INTO esphub.bootloaders (
      id, version, chip, flash_mode, flash_size, flash_freq,
      bootloader_offset, bootloader_key, bootloader_size, bootloader_sha256, bootloader_upload_id,
      partition_table_offset, partition_table_key, partition_table_size, partition_table_sha256, partition_table_upload_id,
      launcher_offset, launcher_key, launcher_size, launcher_sha256, launcher_upload_id,
      app_offset, nvs_offset, nvs_size
    ) VALUES (
      ${row.id}, ${row.version}, ${row.chip}, ${row.flash_mode}, ${row.flash_size}, ${row.flash_freq},
      ${row.bootloader_offset}, ${row.bootloader_key}, ${row.bootloader_size}, ${row.bootloader_sha256}, ${row.bootloader_upload_id},
      ${row.partition_table_offset}, ${row.partition_table_key}, ${row.partition_table_size}, ${row.partition_table_sha256}, ${row.partition_table_upload_id},
      ${row.launcher_offset}, ${row.launcher_key}, ${row.launcher_size}, ${row.launcher_sha256}, ${row.launcher_upload_id},
      ${row.app_offset}, ${row.nvs_offset}, ${row.nvs_size}
    ) ON CONFLICT (id, version) DO NOTHING RETURNING *`;
  if (!inserted) {
    const [raced] =
      await sql`SELECT * FROM esphub.bootloaders WHERE id = ${row.id} AND version = ${row.version}`;
    if (raced && rowsMatch(raced, row)) {
      await env.FIRMWARE.delete(staged.map((item) => item.srcKey)).catch(() => {});
      return { status: 200, body: formatBootloaderRecord(raced) };
    }
    fail(409, "Bootloader version already exists with different content");
  }

  await env.FIRMWARE.delete(staged.map((item) => item.srcKey)).catch(() => {});
  return { status: 201, body: formatBootloaderRecord(inserted) };
}

export async function setCurrentBootloaderRelease(sql, id, input) {
  if (typeof id !== "string" || !bootloaderIdPattern.test(id))
    fail(400, "Invalid bootloader ID");
  if (!isPlainObject(input)) fail(400, "Expected a release request object");
  for (const key of Object.keys(input))
    if (key !== "version") fail(400, "Unexpected " + key);
  if (typeof input.version !== "string" || !versionPattern.test(input.version))
    fail(400, "Invalid bootloader version");

  try {
    const [row] = await sql`INSERT INTO esphub.bootloader_releases (id, version, promoted_at)
      VALUES (${id}, ${input.version}, now())
      ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, promoted_at = now()
      RETURNING id, version, promoted_at`;
    return row;
  } catch (error) {
    if (error?.code === "23503") fail(404, "Bootloader version not found");
    throw error;
  }
}
