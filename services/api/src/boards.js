import { describeExamples } from "../../../firmware-source/shared/board-examples.js";
import { releaseTag } from "../../../firmware-source/shared/firmware-releases.js";
import { boardPhotoOrigin, releaseUrl } from "../../../shared/identity.js";
import { fail } from "./auth.js";

export const boardIdPattern =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const boardImageUrl = (id) => `${boardPhotoOrigin}/boards/${id}/image`;

export async function searchBoards(sql, query = "") {
  if (query.includes("\0")) fail(400, "Invalid query");
  const rows =
    await sql`SELECT b.id, b.name, b.model, b.chip, b.flash_mb, b.default_example, b.examples, b.source_revision, b.preview,
      (SELECT jsonb_object_agg(r.kind, r.version) FROM esphub.firmware_releases r
       WHERE r.board = b.id) AS versions
    FROM esphub.board_profiles b
    WHERE b.is_current AND strpos(b.id, ${query.trim().toLowerCase()}) > 0
    ORDER BY b.display_order NULLS LAST, b.id`;
  return rows.map(({ versions, examples, source_revision, ...board }) => ({
    ...board,
    examples: describeExamples(board.id, examples, source_revision),
    image_url: boardImageUrl(board.id),
    firmware: Object.fromEntries(
      Object.entries(versions ?? {}).map(([kind, version]) => {
        const asset = kind === "bootloader" ? "ota" : kind;
        const tag = releaseTag(kind, board.id, version);
        return [
          kind,
          {
            version,
            download_url: releaseUrl(board.id, asset, tag),
          },
        ];
      }),
    ),
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
