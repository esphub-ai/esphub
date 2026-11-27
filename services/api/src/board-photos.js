import { Hono } from "hono";
import { thumbnailWidths } from "../../../shared/board-photo.js";
import { projectImageUrl } from "../../../shared/identity.js";
import { boardIdPattern, boardImageUrl } from "./boards.js";
import { uuidPattern } from "./ids.js";
import { imageContentTypes, projectImageObjectKey } from "./projects.js";

const allowedWidths = new Set(
  Object.values(thumbnailWidths).flat().map(String),
);
const projectImageFilePattern = /^([0-9a-f]{64})\.(webp|png|jpg)$/;
export const boardPhotos = new Hono();

boardPhotos.get("/boards/:group/:project/image", async (c) => {
  const { group, project } = c.req.param();
  const id = `${group}/${project}`;
  if (!boardIdPattern.test(id)) return c.notFound();
  const width = c.req.query("width");
  if (width !== undefined && !allowedWidths.has(width))
    return c.text("Unsupported thumbnail width", 400);

  const url = new URL(boardImageUrl(id));
  if (width) url.searchParams.set("width", width);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cached = cache && (await cache.match(url.href));
  if (cached) return cached;

  const object = await c.env.FIRMWARE.get(`boards/${id}.webp`);
  if (!object) return c.notFound();
  let response;
  if (width) {
    const image = await c.env.IMAGES.input(object.body)
      .transform({
        width: Number(width),
        height: Number(width),
        fit: "scale-down",
      })
      .output({ format: "image/webp", quality: 80 });
    const output = image.response();
    if (!output.ok) return output;
    response = new Response(output.body, output);
  } else {
    response = new Response(object.body, {
      headers: { "Content-Length": String(object.size), ETag: object.httpEtag },
    });
  }
  response.headers.set("Content-Type", "image/webp");
  response.headers.set("Cache-Control", "public, max-age=300, s-maxage=3600");
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (cache) c.executionCtx.waitUntil(cache.put(url.href, response.clone()));
  return response;
});

boardPhotos.get("/projects/:id/images/:file", async (c) => {
  const { id, file } = c.req.param();
  const match = projectImageFilePattern.exec(file);
  if (!uuidPattern.test(id) || !match) return c.notFound();
  const [, sha256, ext] = match;
  const width = c.req.query("width");
  if (width !== undefined && !allowedWidths.has(width))
    return c.text("Unsupported thumbnail width", 400);

  const url = new URL(projectImageUrl(id, sha256, ext));
  if (width) url.searchParams.set("width", width);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cached = cache && (await cache.match(url.href));
  if (cached) return cached;

  const object = await c.env.FIRMWARE.get(projectImageObjectKey(id, sha256, ext));
  if (!object) return c.notFound();
  let response;
  if (width) {
    const image = await c.env.IMAGES.input(object.body)
      .transform({
        width: Number(width),
        height: Number(width),
        fit: "scale-down",
      })
      .output({ format: "image/webp", quality: 80 });
    const output = image.response();
    if (!output.ok) return output;
    response = new Response(output.body, output);
    response.headers.set("Content-Type", "image/webp");
  } else {
    response = new Response(object.body, {
      headers: {
        "Content-Type": imageContentTypes[ext],
        "Content-Length": String(object.size),
        ETag: object.httpEtag,
      },
    });
  }
  response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (cache) c.executionCtx.waitUntil(cache.put(url.href, response.clone()));
  return response;
});
