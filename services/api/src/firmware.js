import { bootloaderUrl, projectAppUrl } from "../../../shared/identity.js";
import { fail } from "./auth.js";

export const bootloaderIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const versionPattern =
  /^([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?|[0-9a-f]{7,40})$/;
const hex = (n) => "0x" + Number(n).toString(16);

// Files of a bootloader set, keyed by the download name the API exposes.
export const bootloaderFiles = {
  bootloader: { column: "bootloader", file: "bootloader.bin" },
  "partition-table": { column: "partition_table", file: "partition-table.bin" },
  launcher: { column: "launcher", file: "launcher.bin" },
};

export async function latestBootloader(sql, id) {
  if (!id) return null;
  const [row] = await sql`SELECT b.*
    FROM esphub.bootloader_releases r
    JOIN esphub.bootloaders b ON b.id = r.id AND b.version = r.version
    WHERE r.id = ${id}`;
  return row ?? null;
}

export async function bootloaderSet(sql, id, version) {
  if (!id || !bootloaderIdPattern.test(id) || !versionPattern.test(version ?? ""))
    return null;
  const [row] = await sql`SELECT * FROM esphub.bootloaders WHERE id = ${id} AND version = ${version}`;
  return row ?? null;
}

// The board's active shared bootloader set, when promoted.
export function firmwareSummary(bootloader) {
  return {
    ...(bootloader && {
      bootloader: {
        id: bootloader.id,
        version: bootloader.version,
        download_url: bootloaderUrl(bootloader.id, bootloader.version, "launcher"),
      },
    }),
  };
}

export async function boardFirmware(sql, board) {
  const bootloader = await latestBootloader(sql, board.bootloader);
  return { bootloader, firmware: firmwareSummary(bootloader) };
}

// The public files a first install writes before the device's private NVS image:
// the shared bootloader set, plus an optional project app.bin.
export async function flashPlan(sql, bucket, board, app = null) {
  const bootloader = await latestBootloader(sql, board.bootloader);
  if (!bootloader) fail(503, "No bootloader is published for this board yet");
  const files = Object.entries(bootloaderFiles).map(([name, { column, file }]) => ({
    name: file,
    offset: hex(bootloader[column + "_offset"]),
    url: bootloaderUrl(bootloader.id, bootloader.version, name),
    sha256: bootloader[column + "_sha256"],
  }));
  if (app) {
    const appObject = await bucket.head(app.app_key);
    if (!appObject) fail(503, "Published project app unavailable");
    files.push({
      name: "app.bin",
      offset: hex(bootloader.app_offset),
      url: projectAppUrl(app.project_id, app.board_id, app.version),
      sha256: app.app_sha256,
    });
  }
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
  if (!bootloaderIdPattern.test(id) || !versionPattern.test(version) || !entry)
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
