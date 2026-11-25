import {
  assetNames,
  releaseTag,
  releaseVersion,
} from "../../../firmware-source/shared/firmware-releases.js";
import { boardIdPattern } from "./boards.js";
import { releaseUrl } from "../../../shared/identity.js";
import { fail } from "./auth.js";

export async function latestReleaseTag(sql, board, kind) {
  const [row] = await sql`SELECT version FROM esphub.firmware_releases
    WHERE board = ${board} AND kind = ${kind}`;
  if (!row) fail(404, "Unknown " + kind + " release");
  return releaseTag(kind, board, row.version);
}

export async function releaseResponse(board, asset, tag, sql, bucket) {
  if (!boardIdPattern.test(board)) fail(404, "Unknown board");
  const latest = tag === undefined;
  const kind = ["micropython", "native"].includes(asset)
    ? asset
    : ["setup", "setup-manifest"].includes(asset)
      ? "setup"
      : "bootloader";
  if (!Object.hasOwn(assetNames(board, "", kind, ""), asset))
    fail(404, "Unknown download");
  if (latest) tag = await latestReleaseTag(sql, board, kind);
  const version = releaseVersion(tag, kind, board);
  if (!version) fail(404, "Unknown " + kind + " release");
  const prefix = `releases/${tag}/`;
  const marker = await bucket?.get(prefix + "published.json");
  const receipt = marker && (await marker.json().catch(() => null));
  let filename;
  if (
    Array.isArray(receipt?.assets) &&
    receipt.assets.length &&
    receipt.assets.every((a) => typeof a?.name === "string")
  ) {
    // Resolve immutable downloads from their published assets, even if Neon is offline
    // or the board has since changed chip or runtime.
    const [start, end] = assetNames(board, "{chip}", kind, version)[
      asset
    ].split("{chip}");
    filename = receipt.assets.find(({ name }) =>
      end === undefined
        ? name === start
        : name.startsWith(start) && name.endsWith(end) && !name.includes("/"),
    )?.name;
    if (!filename) fail(503, "Published firmware asset unavailable");
  } else {
    // Historical GitHub releases and older R2 markers have no asset inventory.
    const [profile] =
      await sql`SELECT chip, runtime FROM esphub.board_profiles WHERE id = ${board}`;
    if (!profile) fail(404, "Unknown board");
    if (["micropython", "native"].includes(kind) && kind !== profile.runtime)
      fail(404, "Unknown download");
    filename = assetNames(board, profile.chip, kind, version)[asset];
  }
  if (marker) {
    const object = await bucket.get(prefix + filename);
    if (!object) fail(503, "Published firmware asset unavailable");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (asset === "setup-manifest") {
      const manifest = await object.json();
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      return Response.json(
        { ...manifest, download_url: releaseUrl(board, "setup", tag) },
        { headers },
      );
    }
    headers.set("Content-Length", String(object.size));
    headers.set("ETag", object.httpEtag);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    if (latest)
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    return new Response(object.body, { headers });
  }
  return Response.redirect(
    `https://github.com/okou-ai/esphub/releases/download/${tag}/${filename}`,
    302,
  );
}
