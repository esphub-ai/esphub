import { Hono } from "hono";
import postgres from "postgres";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { installAuth, identify, digest, fail } from "./auth.js";
import { operate, tools } from "./operations.js";
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
api.get("/health", (c) => c.json({ service: "esphub-api", ok: true }));
api.get("/releases/:board/:asset", async (c) => {
  const { board, asset } = c.req.param();
  if (
    !["paper-color", "stopwatch"].includes(board) ||
    !["usb", "ota", "manifest"].includes(asset)
  )
    fail(404, "Unknown release asset");
  const index = await c.env.UART.get("releases/latest.json");
  if (!index) fail(404, "Launcher builds are not yet available");
  const manifest = (await index.json())[board];
  if (asset === "manifest") return c.json(manifest);
  const obj = await c.env.UART.get("releases/" + manifest[asset].file);
  if (!obj) fail(503, "Incomplete release");
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition":
        'attachment; filename="' + manifest[asset].file + '"',
      ETag: obj.httpEtag,
    },
  });
});
api.use(
  "*",
  bodyLimit({
    maxSize: 65536,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  }),
);
api.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== c.env.APP_ORIGIN) fail(403, "Origin not allowed");
  const sql = postgres(c.env.DATABASE_URL, {
    max: 1,
    prepare: false,
    connect_timeout: 8,
    idle_timeout: 5,
    fetch_types: false,
  });
  c.set("sql", sql);
  try {
    await next();
  } finally {
    try {
      c.executionCtx.waitUntil(sql.end());
    } catch {
      await sql.end();
    }
  }
  if (c.res.status !== 101) c.header("Cache-Control", "no-store");
});
api.use("/auth/*", async (c, next) => {
  if (c.req.method === "POST" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    fail(403, "Browser origin required");
  if (c.req.path.endsWith("/options") && c.env.AUTH_LIMIT) {
    const r = await c.env.AUTH_LIMIT.limit({
      key: c.req.header("CF-Connecting-IP") || "unknown",
    });
    if (!r.success) fail(429, "Try again later");
  }
  await next();
});
installAuth(api);
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
  if (user.kind === "session" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    fail(403, "Browser origin required");
  return c.json(
    await operate(c, user.owner, c.req.param("name"), await c.req.json()),
  );
});
api.post("/mcp", async (c) => {
  const user = await identify(c, false),
    m = await c.req.json();
  const error = (code, message) =>
    c.json({ jsonrpc: "2.0", id: m?.id ?? null, error: { code, message } });
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string")
    return error(-32600, "Invalid request");
  if (m.id === undefined) return c.body(null, 202);
  let result;
  switch (m.method) {
    case "initialize":
      result = {
        protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(
          m.params?.protocolVersion,
        )
          ? m.params.protocolVersion
          : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "esphub", version: "1.0.0" },
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools };
      break;
    case "tools/call":
      try {
        const value = await operate(
          c,
          user.owner,
          m.params?.name,
          m.params?.arguments ?? {},
        );
        result = { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (e) {
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: e instanceof HTTPException ? e.message : "Operation failed",
            },
          ],
        };
      }
      break;
    default:
      return error(-32601, "Method not found");
  }
  return c.json({ jsonrpc: "2.0", id: m.id, result });
});
api.get("/mcp", (c) => c.body(null, 405, { Allow: "POST" }));
export default api;
