import boards from "../../../shared/boards.generated.json" with { type: "json" };
import {
  assetNames,
  releaseTag,
  releaseVersion,
} from "../../../shared/firmware-releases.js";
import { fail } from "./auth.js";

export async function latestReleaseTag(sql, board, kind) {
  const [row] = await sql`SELECT version FROM esphub.firmware_releases
    WHERE board = ${board} AND kind = ${kind}`;
  if (!row) fail(404, "Unknown " + kind + " release");
  return releaseTag(kind, board, row.version);
}

export async function releaseResponse(board, asset, tag, sql) {
  if (!Object.hasOwn(boards, board)) fail(404, "Unknown board");
  const kind = ["micropython", "native"].includes(asset)
    ? asset
    : ["setup", "setup-manifest"].includes(asset)
      ? "setup"
      : "bootloader";
  const { chip, runtime } = boards[board];
  if (["micropython", "native"].includes(kind) && kind !== runtime)
    fail(404, "Unknown download");
  if (!Object.hasOwn(assetNames(board, chip, kind, ""), asset))
    fail(404, "Unknown download");
  if (tag === undefined) tag = await latestReleaseTag(sql, board, kind);
  const version = releaseVersion(tag, kind, board);
  if (!version) fail(404, "Unknown " + kind + " release");
  const filename = assetNames(board, chip, kind, version)[asset];
  return Response.redirect(
    `https://github.com/okou-ai/esphub/releases/download/${tag}/${filename}`,
    302,
  );
}
