import { boardPhotoOrigin } from "../../../shared/identity.js";
import { firmwareSummary } from "./firmware.js";
import { fail } from "./auth.js";

export const boardIdPattern =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const boardImageUrl = (id) => `${boardPhotoOrigin}/boards/${id}/image`;

export function boardSpec(row) {
  return {
    soc: row.soc,
    flash_mb: row.flash_mb,
    flash_bus: row.flash_bus,
    psram: row.psram,
    console: row.console,
  };
}

export async function searchBoards(sql, query = "") {
  if (query.includes("\0")) fail(400, "Invalid query");
  const rows =
    await sql`SELECT b.id, b.vendor, b.name, b.model, b.soc, b.flash_mb, b.flash_bus, b.psram, b.console,
      b.bootloader AS bootloader_id, b.product_url, b.has_photo, b.preview,
      (SELECT jsonb_build_object('id', r.id, 'version', r.version) FROM esphub.bootloader_releases r
       WHERE r.id = b.bootloader) AS bootloader_release
    FROM esphub.boards b
    WHERE NOT b.retired AND strpos(b.id, ${query.trim().toLowerCase()}) > 0
    ORDER BY b.display_order NULLS LAST, b.id`;
  return rows.map((row) => ({
    id: row.id,
    vendor: row.vendor,
    name: row.name,
    model: row.model,
    bootloader: row.bootloader_id,
    spec: boardSpec(row),
    product_url: row.product_url,
    preview: row.preview,
    image_url: row.has_photo ? boardImageUrl(row.id) : null,
    firmware: firmwareSummary(row.bootloader_release),
  }));
}

export async function getBoardDetail(sql, id) {
  if (!boardIdPattern.test(id)) fail(404, "Unknown board");
  const [row] =
    await sql`SELECT b.id, b.vendor, b.name, b.model, b.soc, b.flash_mb, b.flash_bus, b.psram, b.console,
      b.bootloader AS bootloader_id, b.product_url, b.has_photo, b.preview, b.retired,
      (SELECT jsonb_build_object('id', r.id, 'version', r.version) FROM esphub.bootloader_releases r
       WHERE r.id = b.bootloader) AS bootloader_release
    FROM esphub.boards b
    WHERE b.id = ${id}`;
  if (!row) fail(404, "Unknown board");
  return {
    id: row.id,
    vendor: row.vendor,
    name: row.name,
    model: row.model,
    bootloader: row.bootloader_id,
    spec: boardSpec(row),
    product_url: row.product_url,
    has_photo: row.has_photo,
    preview: row.preview,
    retired: row.retired,
    image_url: row.has_photo ? boardImageUrl(row.id) : null,
    firmware: firmwareSummary(row.bootloader_release),
  };
}

export async function getBoard(sql, id) {
  const [board] = await sql`SELECT * FROM esphub.boards WHERE id = ${id}`;
  if (!board) fail(404, "Unknown board");
  return board;
}

export async function boardGallery(sql) {
  const rows =
    await sql`SELECT id, name, model, soc, flash_mb, flash_bus, psram, console, bootloader, product_url
      FROM esphub.boards
      WHERE NOT retired AND has_photo
      ORDER BY display_order NULLS LAST, id`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    model: row.model,
    bootloader: row.bootloader,
    spec: boardSpec(row),
    product_url: row.product_url,
    image_url: boardImageUrl(row.id),
  }));
}
