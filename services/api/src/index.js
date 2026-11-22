import { maxUploadBytes } from "./uploads.js";
import { releaseResponse } from "./releases.js";
import { Hono } from "hono";
import { withDatabase } from "./database.js";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { allowedOrigin, identify, digest, fail } from "./auth.js";
import { installMcpMetadata, serveMcp, authenticateMcp } from "./mcp.js";
import { operate } from "./operations.js";
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
api.get("/releases/:board/:asset", (c) =>
  releaseResponse(
    c.req.param("board"),
    c.req.param("asset"),
    c.req.query("tag"),
    c.req.query("tag") !== undefined,
  ),
);
api.use(
  "*",
  cors({
    origin: (origin, c) => (allowedOrigin(c, origin) ? origin : undefined),
    credentials: true,
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "MCP-Protocol-Version",
      "Mcp-Method",
      "Mcp-Name",
      "Mcp-Session-Id",
    ],
    exposeHeaders: ["WWW-Authenticate"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
  }),
);
api.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && !allowedOrigin(c, origin)) fail(403, "Origin not allowed");
  await next();
  if (c.res.status !== 101) c.header("Cache-Control", "no-store");
});
api.put("/uploads/:device/:artifact", async (c) => {
  const { device, artifact } = c.req.param();
  if (
    ![device, artifact].every((id) =>
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id),
    )
  )
    fail(404, "Unknown upload");
  if (
    !/^Bearer esh_upload_[A-Za-z0-9_-]{43}$/.test(
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
api.use("*", (c, next) =>
  withDatabase(c.env, (sql) => {
    c.set("sql", sql);
    return next();
  }),
);
api.get("/auth/me", async (c) =>
  c.json({ handle: (await identify(c)).handle }),
);
async function authenticatedDevice(c) {
  const t = c.req
    .header("Authorization")
    ?.match(/^Bearer (okl_dev_[A-Za-z0-9_-]+)$/)?.[1];
  if (!t) fail(401, "Device token required");
  const sql = c.get("sql"),
    [d] =
      await sql`SELECT id FROM esphub.devices WHERE token_hash=${await digest(t)}`;
  if (!d) fail(401, "Invalid device token");
  return { id: d.id, stub: c.env.DEVICE.get(c.env.DEVICE.idFromName(d.id)) };
}
api.get("/api/device/programs/:artifact", async (c) => {
  const { stub } = await authenticatedDevice(c);
  return stub.fetch(
    "https://device/artifacts/" + encodeURIComponent(c.req.param("artifact")),
  );
});
api.get("/api/device/connect", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    fail(426, "WebSocket upgrade required");
  const { id, stub } = await authenticatedDevice(c);
  return stub.fetch("https://device/connect", {
    headers: { Upgrade: "websocket", "X-Device-ID": id },
  });
});
api.post("/operations/:name", async (c) => {
  const user = await identify(c);
  if (!allowedOrigin(c, c.req.header("Origin")))
    fail(403, "Browser origin required");
  return c.json(
    await operate(
      { env: c.env, sql: c.get("sql") },
      user.owner,
      c.req.param("name"),
      await c.req.json(),
    ),
  );
});
export default api;
