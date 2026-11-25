import { releaseTag } from "../../../firmware-source/shared/firmware-releases.js";
import { apiOrigin, releaseUrl } from "../../../shared/identity.js";
import { fail } from "./auth.js";

export const boardIdPattern =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const boardImageUrl = (id) => `${apiOrigin}/boards/${id}/image`;

export async function searchBoards(sql, query = "") {
  if (query.includes("\0")) fail(400, "Invalid query");
  const rows =
    await sql`SELECT b.id, b.name, b.model, b.chip, b.flash_mb, b.runtime, b.preview,
      (SELECT jsonb_object_agg(r.kind, r.version) FROM esphub.firmware_releases r
       WHERE r.board = b.id AND (r.kind IN ('bootloader', 'setup') OR r.kind = b.runtime)) AS versions
    FROM esphub.board_profiles b
    WHERE b.is_current AND strpos(b.id, ${query.trim().toLowerCase()}) > 0
    ORDER BY b.display_order NULLS LAST, b.id`;
  return rows.map(({ versions, ...board }) => ({
    ...board,
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

export async function boardImage(bucket, id) {
  if (!boardIdPattern.test(id)) fail(404, "Unknown board image");
  const object = await bucket.get(`boards/${id}.webp`);
  if (!object) fail(404, "Board image not found");
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
