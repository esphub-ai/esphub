import { boardIdPattern } from "./boards.js";
import { fail } from "./auth.js";

// The firmware publisher records every app it publishes. A tag selects that exact
// release; without one, the board's latest app is used.
export async function releaseFile(sql, board, tag) {
  const [file] =
    tag === undefined
      ? await sql`SELECT a.tag, a.object_key, a.size FROM esphub.firmware_releases r
          JOIN esphub.release_assets a ON a.tag = r.tag AND a.board = r.board
          WHERE r.board = ${board} AND r.kind = 'app' AND a.asset = 'app'`
      : await sql`SELECT tag, object_key, size FROM esphub.release_assets
          WHERE board = ${board} AND asset = 'app' AND tag = ${tag}`;
  if (!file) fail(404, "Unknown release");
  // PostgreSQL returns bigint as a string.
  return { ...file, size: file.size === null ? null : Number(file.size) };
}

export async function releaseResponse(board, asset, tag, sql, bucket) {
  if (!boardIdPattern.test(board) || asset !== "app") fail(404, "Unknown release");
  const file = await releaseFile(sql, board, tag);
  const object = await bucket.get(file.object_key);
  if (!object) fail(503, "Published firmware asset unavailable");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (tag === undefined)
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(object.body, { headers });
}
