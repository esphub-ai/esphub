import { bootloaderUrl, releaseUrl } from "../../../shared/identity.js";
import { fail } from "./auth.js";

const segment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const hex = (n) => "0x" + Number(n).toString(16);

// Files of a bootloader set, keyed by the download name the API exposes.
export const bootloaderFiles = {
  bootloader: { column: "bootloader", file: "bootloader.bin" },
  "partition-table": { column: "partition_table", file: "partition-table.bin" },
  launcher: { column: "launcher", file: "launcher.bin" },
};

export async function latestBootloader(sql, id) {
  if (!id) return null;
  const [row] = await sql`SELECT * FROM esphub.bootloaders WHERE id = ${id}
    ORDER BY string_to_array(version, '.')::int[] DESC LIMIT 1`;
  return row ?? null;
}

export async function bootloaderSet(sql, id, version) {
  if (!id || !segment.test(id) || !versionPattern.test(version ?? "")) return null;
  const [row] = await sql`SELECT * FROM esphub.bootloaders WHERE id = ${id} AND version = ${version}`;
  return row ?? null;
}

export async function latestApp(sql, board) {
  const [row] = await sql`SELECT r.version, r.tag, a.object_key, a.size
    FROM esphub.firmware_releases r JOIN esphub.release_assets a ON a.tag = r.tag AND a.board = r.board
    WHERE r.board = ${board} AND r.kind = 'app' AND a.asset = 'app'`;
  return row ? { ...row, size: row.size === null ? null : Number(row.size) } : null;
}

// The firmware a board can install today: its latest app and its latest bootloader set.
export function firmwareSummary(board, app, bootloader) {
  return {
    ...(app && {
      app: { version: app.version, download_url: releaseUrl(board, "app", app.tag) },
    }),
    ...(bootloader && {
      bootloader: {
        id: bootloader.id,
        version: bootloader.version,
        download_url: bootloaderUrl(bootloader.id, bootloader.version, "launcher"),
      },
    }),
  };
}

export async function boardFirmware(sql, profile) {
  const [app, bootloader] = await Promise.all([
    latestApp(sql, profile.id),
    latestBootloader(sql, profile.bootloader),
  ]);
  return { app, bootloader, firmware: firmwareSummary(profile.id, app, bootloader) };
}

// The public files a first install writes before the device's private NVS image.
export async function flashPlan(sql, bucket, profile) {
  const { app, bootloader } = await boardFirmware(sql, profile);
  if (!bootloader) fail(503, "No bootloader is published for this board yet");
  if (!app) fail(503, "No app is published for this board yet");
  const appObject = await bucket.head(app.object_key);
  if (!appObject) fail(503, "Published app unavailable");
  const files = Object.entries(bootloaderFiles).map(([name, { column, file }]) => ({
    name: file,
    offset: hex(bootloader[column + "_offset"]),
    url: bootloaderUrl(bootloader.id, bootloader.version, name),
    sha256: bootloader[column + "_sha256"],
  }));
  files.push({
    name: "app.bin",
    offset: hex(bootloader.app_offset),
    url: releaseUrl(profile.id, "app", app.tag),
    ...(appObject.customMetadata?.sha256 && { sha256: appObject.customMetadata.sha256 }),
  });
  return { bootloader, app, files };
}

export function esptoolCommand(bootloader, files) {
  const sorted = [...files].sort((a, b) => Number(a.offset) - Number(b.offset));
  return [
    `esptool.py --chip ${bootloader.chip} --port PORT write_flash --erase-all`,
    `--flash_mode ${bootloader.flash_mode} --flash_size ${bootloader.flash_size} --flash_freq ${bootloader.flash_freq}`,
    ...sorted.map(({ offset, name }) => `${offset} ${name}`),
  ].join(" ");
}

export async function bootloaderResponse(sql, bucket, id, version, file) {
  const entry = Object.hasOwn(bootloaderFiles, file) ? bootloaderFiles[file] : null;
  if (!segment.test(id) || !versionPattern.test(version) || !entry)
    fail(404, "Unknown bootloader file");
  const row = await bootloaderSet(sql, id, version);
  if (!row) fail(404, "Unknown bootloader file");
  const object = await bucket.get(row[entry.column + "_key"]);
  if (!object) fail(503, "Published bootloader file unavailable");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}
