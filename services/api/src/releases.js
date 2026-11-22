import setupRelease from "../../../shared/setup-release.json" with { type: "json" };
import { fail } from "./auth.js";

const releases = "https://github.com/okou-ai/esphub/releases";
const tagPattern = /^launcher-v(\d+\.\d+\.\d+)$/;
const extensions = {
  manifest: ".json",
  usb: "-usb.zip",
  setup: "-setup.zip",
  "setup-manifest": "-setup.json",
  ota: "-ota.bin",
};

async function resolveTag(tag) {
  if (!tag) {
    const response = await fetch(releases + "/latest", {
      method: "HEAD",
      redirect: "manual",
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    const location = response.headers.get("Location") || "";
    const prefix = releases + "/tag/";
    if (response.status !== 302 || !location.startsWith(prefix))
      fail(503, "Latest GitHub release unavailable");
    tag = location.slice(prefix.length);
  }
  if (!tagPattern.test(tag)) fail(404, "Unknown launcher release");
  return tag;
}

function assetURL(board, kind, tag) {
  if (
    !["paper-color", "stopwatch"].includes(board) ||
    !Object.hasOwn(extensions, kind)
  )
    fail(404, "Unknown launcher download");
  return (
    releases +
    "/download/" +
    tag +
    "/esphub-" +
    board +
    "-esp32s3-" +
    tag.slice("launcher-v".length) +
    extensions[kind]
  );
}

export async function launcherManifest(board) {
  const tag = await resolveTag();
  const r = await fetch(assetURL(board, "manifest", tag), {
    redirect: "follow",
  });
  if (!r.ok) fail(503, "GitHub launcher manifest unavailable");
  const m = await r.json();
  if (
    m.board !== board ||
    m.chip !== "esp32s3" ||
    "launcher-v" + m.version !== tag ||
    !/^[a-f0-9]{64}$/.test(m.ota?.sha256) ||
    !Number.isSafeInteger(m.ota.size) ||
    m.ota.size <= 0
  )
    fail(503, "Invalid launcher manifest");
  return m;
}

export async function releaseResponse(board, kind, tag, deviceDownload) {
  if (kind === "micropython") {
    const version = tag
      ? /^micropython-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1]
      : setupRelease.runtime_version;
    if (!version || !["paper-color", "stopwatch"].includes(board))
      fail(404, "Unknown MicroPython image");
    return Response.redirect(
      `${releases}/download/micropython-v${version}/esphub-${board}-micropython-${version}.bin`,
      302,
    );
  }
  if (kind === "setup" || kind === "setup-manifest") {
    const version = tag
      ? /^setup-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1]
      : setupRelease.version;
    if (!version || !["paper-color", "stopwatch"].includes(board))
      fail(404, "Unknown USB setup kit");
    return Response.redirect(
      `${releases}/download/setup-v${version}/esphub-${board}-esp32s3-${version}${extensions[kind]}`,
      302,
    );
  }
  const url = assetURL(board, kind, await resolveTag(tag));
  if (!deviceDownload || kind !== "ota") return Response.redirect(url, 302);
  // The deployed ESP-IDF installer expects a direct 200 response to a pinned download.
  const r = await fetch(url, { redirect: "follow" });
  if (r.status !== 200) fail(503, "GitHub launcher image unavailable");
  return new Response(r.body, r);
}
