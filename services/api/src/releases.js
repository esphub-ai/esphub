import { fail } from "./auth.js";

const repository = "https://api.github.com/repos/okou-ai/esphub";
const boards = ["paper-color", "stopwatch"];
function headers(env, accept) {
  const value = { Accept: accept, "User-Agent": "esphub-release-downloads" };
  if (env.GITHUB_RELEASES_TOKEN)
    value.Authorization = "Bearer " + env.GITHUB_RELEASES_TOKEN;
  return value;
}
export async function releaseAsset(env, board, kind, tag = "latest") {
  if (
    !boards.includes(board) ||
    !["manifest", "usb", "ota"].includes(kind) ||
    (tag !== "latest" && !/^launcher-v\d+\.\d+\.\d+$/.test(tag))
  )
    fail(404, "Unknown launcher download");
  const route = tag === "latest" ? tag : "tags/" + tag;
  const r = await fetch(repository + "/releases/" + route, {
    headers: headers(env, "application/vnd.github+json"),
    cf: { cacheEverything: true, cacheTtl: 60 },
  });
  if (!r.ok) fail(503, "GitHub release metadata is unavailable");
  const release = await r.json();
  const version = release.tag_name.match(/^launcher-v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version || release.draft || release.prerelease)
    fail(503, "Invalid launcher release");
  const ext = { manifest: ".json", usb: "-usb.zip", ota: "-ota.bin" }[kind];
  const filename = "esphub-" + board + "-esp32s3-" + version + ext;
  const asset = release.assets.find(
    (a) => a.name === filename && a.state === "uploaded",
  );
  if (!asset || !Number.isSafeInteger(asset.id))
    fail(404, "Release asset unavailable");
  return { asset, tag: release.tag_name, version };
}

export async function download(env, asset) {
  const r = await fetch(repository + "/releases/assets/" + asset.id, {
    headers: headers(env, "application/octet-stream"),
    redirect: "manual",
    cache: "no-store",
  });
  if (r.status === 200) return r;
  if (r.status !== 302) fail(503, "GitHub download unavailable");
  const url = new URL(r.headers.get("Location"));
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".githubusercontent.com")
  )
    fail(503, "Invalid GitHub download location");
  return Response.redirect(url.href, 302);
}

export async function releaseResponse(env, board, kind, tag) {
  const { asset } = await releaseAsset(env, board, kind, tag);
  const source = await download(env, asset);
  if (source.status === 302 && kind !== "ota") return source;
  // ESP-IDF's streaming installer expects a 200 with a content length.
  const r =
    source.status === 302
      ? await fetch(source.headers.get("Location"))
      : source;
  if (!r.ok) fail(503, "GitHub download unavailable");
  return new Response(r.body, {
    headers: {
      "Content-Type":
        kind === "manifest" ? "application/json" : "application/octet-stream",
      "Content-Length": String(asset.size),
      "Content-Disposition": 'attachment; filename="' + asset.name + '"',
      "Cache-Control": "no-store",
    },
  });
}
