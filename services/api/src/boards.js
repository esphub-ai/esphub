import { boardPhotoOrigin } from "../../../shared/identity.js";
import { firmwareSummary } from "./firmware.js";
import { fail } from "./auth.js";

export const boardIdPattern =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const boardImageUrl = (id) => `${boardPhotoOrigin}/boards/${id}/image`;

export async function searchBoards(sql, query = "") {
  if (query.includes("\0")) fail(400, "Invalid query");
  const rows =
    await sql`SELECT b.id, b.name, b.model, b.chip, b.flash_mb, b.default_example, b.preview, b.published_examples,
      (SELECT jsonb_build_object('version', r.version, 'tag', r.tag) FROM esphub.firmware_releases r
       WHERE r.board = b.id AND r.kind = 'app') AS app,
      (SELECT jsonb_build_object('id', r.id, 'version', r.version) FROM esphub.bootloader_releases r
       WHERE r.id = b.bootloader) AS bootloader
    FROM esphub.board_profiles b
    WHERE b.is_current AND strpos(b.id, ${query.trim().toLowerCase()}) > 0
    ORDER BY b.display_order NULLS LAST, b.id`;
  return rows.map(({ app, bootloader, published_examples, ...board }) => ({
    ...board,
    examples: published_examples,
    image_url: boardImageUrl(board.id),
    firmware: firmwareSummary(board.id, app, bootloader),
  }));
}

export async function getBoard(sql, id) {
  const [profile] =
    await sql`SELECT * FROM esphub.board_profiles WHERE id = ${id}`;
  if (!profile) fail(404, "Unknown board");
  return profile;
}

async function photographedBoards(bucket) {
  const ids = new Set();
  let cursor;
  do {
    const page = await bucket.list({ prefix: "boards/", cursor });
    for (const { key } of page.objects) {
      if (key.endsWith(".webp")) ids.add(key.slice("boards/".length, -5));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return ids;
}

export async function boardGallery(sql, bucket) {
  const [boards, photos] = await Promise.all([
    sql`SELECT b.id, b.name, b.model, b.chip, b.flash_mb, p.product_url
        FROM esphub.board_profiles b LEFT JOIN esphub.board_product_pages p ON p.board = b.id
        WHERE b.is_current ORDER BY b.display_order NULLS LAST, b.id`,
    photographedBoards(bucket),
  ]);
  return boards.filter(({ id }) => photos.has(id)).map((board) => ({
    ...board,
    image_url: boardImageUrl(board.id),
  }));
}
