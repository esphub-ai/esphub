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

export async function publishedAsset(board, kind, asset, tag, bucket) {
  const version = releaseVersion(tag, kind, board);
  if (!version) fail(404, "Unknown " + kind + " release");
  const prefix = `releases/${tag}/`;
  const marker = await bucket?.get(prefix + "published.json");
  const receipt = marker && (await marker.json().catch(() => null));
  if (!Array.isArray(receipt?.assets)) fail(404, "Unpublished release");
  const [start, end] = assetNames(board, "{chip}", kind, version)[
    asset
  ].split("{chip}");
  const file = receipt.assets.find(({ name }) =>
    end === undefined
      ? name === start
      : name.startsWith(start) && name.endsWith(end) && !name.includes("/"),
  );
  if (!file) fail(503, "Published firmware asset unavailable");
  return { key: prefix + file.name, size: file.size };
}

export async function releaseResponse(board, asset, tag, sql, bucket) {
  if (!boardIdPattern.test(board)) fail(404, "Unknown board");
  const latest = tag === undefined;
  const kind = asset === "app" ? asset :
    ["setup", "setup-manifest"].includes(asset) ? "setup" : "bootloader";
  if (!Object.hasOwn(assetNames(board, "", kind, ""), asset))
    fail(404, "Unknown download");
  if (latest) tag = await latestReleaseTag(sql, board, kind);
  const file = await publishedAsset(board, kind, asset, tag, bucket);
  const object = await bucket.get(file.key);
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
