import { enroll, publishDownlink } from "./iot.js";
import { retryDue } from "./commands.js";
import { maxUploadBytes } from "./uploads.js";
import { boardGallery, getBoardDetail, searchBoards } from "./boards.js";
import { boardPhotos } from "./board-photos.js";
import { boardPhotoOrigin } from "../../../shared/identity.js";
import { uuidPattern } from "./ids.js";
import { bootloaderResponse } from "./firmware.js";
import { Hono } from "hono";
import { withDatabase } from "./database.js";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import {
  allowedOrigin,
  identify,
  identifyApiSubject,
  identifyApiUser,
  identifyMachine,
  digest,
  fail,
} from "./auth.js";
import {
  createBootloaderVersion,
  createInternalUploads,
  setCurrentBootloaderRelease,
} from "./bootloader-publish.js";
import {
  archiveProject,
  createProject,
  createProjectRelease,
  createUserUploads,
  getOwnedProject,
  getPublicProject,
  listAuthors,
  listOwnedProjects,
  listPublicProjects,
  listPublicProjectsPage,
  projectAppResponse,
  removeProjectBoard,
  setCurrentProjectBoardRelease,
  setProjectVisibility,
  updateProject,
} from "./projects.js";
import { installMcpMetadata, serveMcp, authenticateMcp } from "./mcp.js";
import { operate } from "./operations.js";
import { createDeviceSetup, reissueDeviceSetup } from "./setup.js";
export { Device } from "./device.js";
const api = new Hono();
api.onError((e, c) =>
  c.json(
    {
      error: e instanceof HTTPException ? e.message : "Internal service error",
    },
    e instanceof HTTPException ? e.status : 500,
  ),
);
installMcpMetadata(api);
api.get("/.well-known/openai-apps-challenge", (c) =>
  c.text("oQ1H5PIXgb4CmexhOlNNaTL2PkqnNppa17GSplpdaPY"),
);
api.get("/health", (c) => c.json({ service: "esphub-api", ok: true }));
api.get("/bootloaders/:id/:version/:file", (c) => {
  const { id, version, file } = c.req.param();
  return withDatabase(c.env, (sql) =>
    bootloaderResponse(sql, c.env.FIRMWARE, id, version, file),
  );
});
api.get("/projects/:id/boards/:vendor/:slug/app", (c) => {
  const { id, vendor, slug } = c.req.param();
  return withDatabase(c.env, (sql) =>
    projectAppResponse(sql, c.env.FIRMWARE, id, `${vendor}/${slug}`, undefined, {
      secret: c.env.IOT_RELAY_SECRET,
      exp: c.req.query("exp"),
      sig: c.req.query("sig"),
    }),
  );
});
api.get("/projects/:id/boards/:vendor/:slug/releases/:version/app", (c) => {
  const { id, vendor, slug, version } = c.req.param();
  return withDatabase(c.env, (sql) =>
    projectAppResponse(sql, c.env.FIRMWARE, id, `${vendor}/${slug}`, version, {
      secret: c.env.IOT_RELAY_SECRET,
      exp: c.req.query("exp"),
      sig: c.req.query("sig"),
    }),
  );
});
api.get("/boards/gallery", (c) =>
  withDatabase(c.env, async (sql) =>
    c.json(await boardGallery(sql), 200, {
      "Cache-Control": "public, max-age=60",
    }),
  ),
);
api.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && !allowedOrigin(c, origin)) fail(403, "Origin not allowed");
  await next();
  if (c.res.status !== 101) c.header("Cache-Control", "no-store");
});
api.get("/setup/:device/:nvs", async (c) => {
  const { device, nvs } = c.req.param();
  if (![device, nvs].every((id) => uuidPattern.test(id)))
    fail(404, "Unknown setup image");
  if (
    !/^Bearer eh_nvs_[A-Za-z0-9_-]{43}$/.test(
      c.req.header("Authorization") ?? "",
    )
  )
    fail(403, "Setup credential required");
  const stub = c.env.DEVICE.get(c.env.DEVICE.idFromName(device));
  return stub.fetch(
    new Request("https://device/setup-nvs/" + nvs, {
      method: "GET",
      headers: { Authorization: c.req.header("Authorization") },
    }),
  );
});
api.put("/uploads/:device/:artifact", async (c) => {
  const { device, artifact } = c.req.param();
  if (![device, artifact].every((id) => uuidPattern.test(id)))
    fail(404, "Unknown upload");
  if (
    !/^Bearer eh_upload_[A-Za-z0-9_-]{43}$/.test(
      c.req.header("Authorization") ?? "",
    )
  )
    fail(403, "Upload credential required");
  const size = Number(c.req.header("Content-Length"));
  if (!Number.isSafeInteger(size) || size <= 0)
    fail(411, "Content-Length required");
  if (size > maxUploadBytes) fail(413, "Upload too large");
  const stub = c.env.DEVICE.get(c.env.DEVICE.idFromName(device));
  return stub.fetch(
    new Request("https://device/uploads/" + artifact, c.req.raw),
  );
});
api.use(
  "*",
  bodyLimit({
    maxSize: 65536,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  }),
);
api.all("/mcp", authenticateMcp, serveMcp);
async function readJsonBody(c) {
  try {
    return await c.req.json();
  } catch {
    fail(400, "Invalid JSON body");
  }
}
api.post("/internal/uploads", async (c) => {
  await identifyMachine(c);
  return c.json(await createInternalUploads(c.env, await readJsonBody(c)), 201);
});
api.post("/v1/uploads", async (c) => {
  await identifyApiSubject(c);
  return c.json(await createUserUploads(c.env, await readJsonBody(c)), 201);
});
api.use("*", (c, next) =>
  withDatabase(c.env, (sql) => {
    c.set("sql", sql);
    return next();
  }),
);
api.get("/boards", async (c) =>
  c.json(await searchBoards(c.get("sql"), c.req.query("q"))),
);
api.get("/boards/:vendor/:slug", async (c) => {
  const id = `${c.req.param("vendor")}/${c.req.param("slug")}`;
  return c.json(await getBoardDetail(c.get("sql"), id));
});
api.get("/authors", async (c) => c.json(await listAuthors(c.get("sql"))));
api.get("/projects", async (c) => {
  const page = c.req.query("page");
  const limit = c.req.query("limit");
  if (page !== undefined || limit !== undefined) {
    return c.json(
      await listPublicProjectsPage(c.get("sql"), {
        board: c.req.query("board"),
        vendor: c.req.query("vendor"),
        soc: c.req.query("soc"),
        tag: c.req.query("tag"),
        exclude_tag: c.req.query("exclude_tag"),
        author: c.req.query("author"),
        query: c.req.query("q") ?? "",
        sort: c.req.query("sort"),
        page,
        limit,
      }),
    );
  }
  return c.json(
    await listPublicProjects(c.get("sql"), {
      board: c.req.query("board"),
      tag: c.req.query("tag"),
      exclude_tag: c.req.query("exclude_tag"),
      author: c.req.query("author"),
      query: c.req.query("q") ?? "",
    }),
  );
});
api.get("/projects/:id", async (c) =>
  c.json(await getPublicProject(c.get("sql"), c.req.param("id"))),
);
api.get("/v1/me", async (c) => {
  const user = await identifyApiUser(c);
  return c.json({
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    is_staff: user.is_staff,
  });
});
api.get("/v1/projects", async (c) => {
  const user = await identifyApiUser(c);
  return c.json(
    await listOwnedProjects(c.get("sql"), user.owner, {
      includeArchived: c.req.query("include_archived") === "true",
    }),
  );
});
api.post("/v1/projects", async (c) => {
  const user = await identifyApiUser(c);
  return c.json(
    await createProject(c.get("sql"), user.owner, await readJsonBody(c), {
      isStaff: user.is_staff,
    }),
    201,
  );
});
api.get("/v1/projects/:id", async (c) => {
  const user = await identifyApiUser(c);
  return c.json(
    await getOwnedProject(c.get("sql"), user.owner, c.req.param("id")),
  );
});
api.put("/v1/projects/:id", async (c) => {
  const user = await identifyApiUser(c);
  return c.json(
    await updateProject(
      c.env,
      c.get("sql"),
      user.owner,
      c.req.param("id"),
      await readJsonBody(c),
      { isStaff: user.is_staff },
    ),
  );
});
api.put("/v1/projects/:id/visibility", async (c) => {
  const user = await identifyApiUser(c);
  return c.json(
    await setProjectVisibility(
      c.get("sql"),
      user.owner,
      c.req.param("id"),
      await readJsonBody(c),
    ),
  );
});
api.delete("/v1/projects/:id", async (c) => {
  const user = await identifyApiUser(c);
  return c.json(
    await archiveProject(c.get("sql"), user.owner, c.req.param("id")),
  );
});
api.post("/v1/projects/:id/releases", async (c) => {
  const user = await identifyApiUser(c);
  const { status, body } = await createProjectRelease(
    c.env,
    c.get("sql"),
    user.owner,
    c.req.param("id"),
    await readJsonBody(c),
  );
  return c.json(body, status);
});
api.put("/v1/projects/:id/boards/:vendor/:slug/current", async (c) => {
  const user = await identifyApiUser(c);
  const boardId = `${c.req.param("vendor")}/${c.req.param("slug")}`;
  return c.json(
    await setCurrentProjectBoardRelease(
      c.get("sql"),
      user.owner,
      c.req.param("id"),
      boardId,
      await readJsonBody(c),
    ),
  );
});
api.delete("/v1/projects/:id/boards/:vendor/:slug", async (c) => {
  const user = await identifyApiUser(c);
  const boardId = `${c.req.param("vendor")}/${c.req.param("slug")}`;
  return c.json(
    await removeProjectBoard(c.get("sql"), user.owner, c.req.param("id"), boardId),
  );
});
async function authenticatedDevice(c) {
  const t = c.req
    .header("Authorization")
    ?.match(/^Bearer (eh_dev_[A-Za-z0-9_-]+)$/)?.[1];
  if (!t) fail(401, "Device token required");
  const hash = await digest(t);
  const sql = c.get("sql"),
    [d] = await sql`SELECT id FROM esphub.devices WHERE token_hash=${hash}`;
  if (!d) fail(401, "Invalid device token");
  return { ...d, hash, stub: c.env.DEVICE.get(c.env.DEVICE.idFromName(d.id)) };
}
function validBoot(id) {
  return typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
}
api.post("/api/device/iot/enroll", async (c) => {
  const d = await authenticatedDevice(c),
    { csr } = await c.req.json();
  return c.json(await enroll(c.env, c.get("sql"), d.id, d.hash, csr));
});
// Only the IoT rule relay has this credential. Device identity and certificate
// come from the broker's topic and principal, outside the device-controlled frame.
api.post("/internal/iot/uplink", async (c) => {
  if (
    !c.env.IOT_RELAY_SECRET ||
    c.req.header("Authorization") !== "Bearer " + c.env.IOT_RELAY_SECRET
  )
    fail(401, "Broker authentication required");
  const { device, principal, frame } = await c.req.json();
  if (
    !uuidPattern.test(device) ||
    !/^[a-f0-9]{64}$/.test(principal) ||
    !validBoot(frame?.boot_id) ||
    !Number.isSafeInteger(frame.mid) ||
    frame.mid < 1
  )
    fail(400, "Invalid uplink");
  const stub = c.env.DEVICE.get(c.env.DEVICE.idFromName(device));
  const response = await stub.fetch("https://device/uplink", {
    method: "POST",
    body: JSON.stringify({ device, principal, frame }),
  });
  if (!response.ok) return response;
  const ack = await response.json();
  if (frame.confirm === true)
    await publishDownlink(c.env, device, {
      boot_id: frame.boot_id,
      mid: frame.mid,
      ...ack,
    });
  return c.json({ ok: true });
});
api.post("/internal/bootloaders", async (c) => {
  await identifyMachine(c);
  const { status, body } = await createBootloaderVersion(
    c.env,
    c.get("sql"),
    await readJsonBody(c),
  );
  return c.json(body, status);
});
api.put("/internal/bootloaders/:id/current", async (c) => {
  await identifyMachine(c);
  return c.json(
    await setCurrentBootloaderRelease(
      c.get("sql"),
      c.req.param("id"),
      await readJsonBody(c),
    ),
  );
});
api.get("/api/device/artifacts/:artifact", async (c) => {
  const { stub } = await authenticatedDevice(c);
  return stub.fetch(
    "https://device/artifacts/" + encodeURIComponent(c.req.param("artifact")),
  );
});
api.post("/setup", async (c) => {
  const user = await identify(c);
  return c.json(
    await createDeviceSetup(
      { env: c.env, sql: c.get("sql") },
      user.owner,
      await c.req.json(),
    ),
  );
});
api.post("/setup/:device/reissue", async (c) => {
  const user = await identify(c);
  const text = await c.req.text();
  let body = {};
  if (text.trim().length) {
    try {
      body = JSON.parse(text);
    } catch {
      fail(400, "Invalid JSON body");
    }
  }
  return c.json(
    await reissueDeviceSetup(
      { env: c.env, sql: c.get("sql") },
      user.owner,
      c.req.param("device"),
      body,
    ),
  );
});
// The console lists devices through the website. Agents use MCP for every other tool.
api.post("/operations/devices_list", async (c) => {
  const user = await identify(c);
  if (!allowedOrigin(c, c.req.header("Origin")))
    fail(403, "Browser origin required");
  return c.json(
    await operate(
      { env: c.env, sql: c.get("sql") },
      user.owner,
      "devices_list",
      await c.req.json(),
    ),
  );
});
export default {
  fetch(request, env, ctx) {
    const router = new URL(request.url).origin === boardPhotoOrigin ? boardPhotos : api;
    return router.fetch(request, env, ctx);
  },
  async scheduled(_event, env) {
    await withDatabase(env, (db) => retryDue(db, env));
  },
};
