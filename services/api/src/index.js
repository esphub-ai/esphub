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
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);
api.use(
  "*",
  bodyLimit({
    maxSize: 65536,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  }),
);
api.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && !allowedOrigin(c, origin)) fail(403, "Origin not allowed");
  await next();
  if (c.res.status !== 101) c.header("Cache-Control", "no-store");
});
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
api.get("/api/device/connect", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    fail(426, "WebSocket upgrade required");
  const t = c.req
    .header("Authorization")
    ?.match(/^Bearer (okl_dev_[A-Za-z0-9_-]+)$/)?.[1];
  if (!t) fail(401, "Device token required");
  const sql = c.get("sql"),
    [d] =
      await sql`SELECT id FROM esphub.devices WHERE token_hash=${await digest(t)}`;
  if (!d) fail(401, "Invalid device token");
  return c.env.DEVICE.get(c.env.DEVICE.idFromName(d.id)).fetch(
    "https://device/connect",
    { headers: { Upgrade: "websocket", "X-Device-ID": d.id } },
  );
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
