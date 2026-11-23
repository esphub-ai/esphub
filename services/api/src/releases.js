import boards from "../../../shared/boards.generated.json" with { type: "json" };
import {
  assetNames,
  publishedFirmware,
  releaseVersion,
} from "../../../shared/firmware-releases.js";
import { fail } from "./auth.js";

const releases = "https://github.com/okou-ai/esphub/releases/download";
async function artifact(board, asset, tag) {
  if (!Object.hasOwn(boards, board)) fail(404, "Unknown board");
  const kind =
    asset === "micropython"
      ? asset
      : ["setup", "setup-manifest"].includes(asset)
        ? "setup"
        : "bootloader";
  const chip = boards[board].chip;
  if (!Object.hasOwn(assetNames(board, chip, kind, ""), asset))
    fail(404, "Unknown download");
  if (tag === undefined) {
    let published;
    try {
      published = await publishedFirmware({ [board]: boards[board] });
    } catch {
      fail(503, "GitHub release index unavailable");
    }
    tag = published[board][kind]?.tag;
  }
  const version = tag && releaseVersion(tag, kind, board);
  if (!version) fail(404, "Unknown " + kind + " release");
  const filename = assetNames(board, chip, kind, version)[asset];
  return { tag, version, url: `${releases}/${tag}/${filename}` };
}

export async function bootloaderManifest(board) {
  const { tag, version, url } = await artifact(board, "manifest");
  const r = await fetch(url);
  if (!r.ok) fail(503, "Official EspHub Bootloader manifest unavailable");
  const m = await r.json();
  if (
    m.board !== board ||
    m.chip !== boards[board].chip ||
    m.version !== version ||
    m.bootloader !== boards[board].bootloader ||
    m.flash_mb !== boards[board].flash_mb ||
    !/^[a-f0-9]{64}$/.test(m.ota?.sha256) ||
    !Number.isSafeInteger(m.ota.size) ||
    m.ota.size <= 0
  )
    fail(503, "Invalid EspHub Bootloader manifest");
  return { ...m, tag };
}

export async function releaseResponse(board, kind, tag) {
  const { url } = await artifact(board, kind, tag);
  return Response.redirect(url, 302);
}
