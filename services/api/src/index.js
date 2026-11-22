import { syncBle } from "./ble.js";
import { enroll, publishWake } from "./iot.js";
import { pull, retryDue } from "./commands.js";
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
  const hash = await digest(t);
  const sql = c.get("sql"),
    [d] =
      await sql`SELECT id,boot_id FROM esphub.devices WHERE token_hash=${hash}`;
  if (!d) fail(401, "Invalid device token");
  return { ...d, hash, stub: c.env.DEVICE.get(c.env.DEVICE.idFromName(d.id)) };
}
api.put("/api/device/program/:pid", async (c) => {
  const { stub } = await authenticatedDevice(c),
    pid = c.req.param("pid");
  let status = c.req.header("X-Program-Status");
  if (
    !/^[0-9a-f-]{8,36}$/i.test(pid) ||
    !["available", "missing", "too_large", "unreadable"].includes(status)
  )
    fail(400, "Invalid program snapshot");
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > 32768) fail(413, "Program too large");
  if (status !== "available" && bytes.byteLength)
    fail(400, "Unexpected source");
  let source = null;
  if (status === "available") {
    try {
      source = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      status = "unreadable";
    }
  }
  return stub.fetch("https://device/record-program", {
    method: "POST",
    body: JSON.stringify({ pid, status, source }),
  });
});
function validBoot(id) {
  return typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
}
api.post("/api/device/iot/enroll", async (c) => {
  const d = await authenticatedDevice(c),
    db = c.get("sql"),
    { csr, boot_id } = await c.req.json();
  if (!validBoot(boot_id)) fail(400, "Invalid boot ID");
  const result = await enroll(c.env, db, d.id, d.hash, csr);
  const rows =
    await db`UPDATE esphub.devices SET enrolled_boot=${boot_id} WHERE id=${d.id} AND token_hash=${d.hash} AND cert_ready RETURNING id`;
  if (!rows.length) fail(409, "Enrollment changed");
  return c.json(result);
});
api.post("/api/device/iot/pull", async (c) => {
  const d = await authenticatedDevice(c),
    { boot_id } = await c.req.json();
  if (!validBoot(boot_id) || d.boot_id !== boot_id) fail(409, "Stale boot");
  return c.json({ commands: await pull(c.get("sql"), d.id, boot_id) });
});
api.post("/api/device/ble/sync", async (c) => {
  const d = await authenticatedDevice(c),
    { generation } = await c.req.json();
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation >= 2147483647
  )
    fail(400, "Invalid BLE generation");
  return c.json((await syncBle(c.get("sql"), d.id, d.hash, generation)) ?? {});
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
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(device) ||
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
    await publishWake(c.env, device, {
      boot_id: frame.boot_id,
      mid: frame.mid,
      ...ack,
    });
  return c.json({ ok: true });
});
api.get("/api/device/programs/:artifact", async (c) => {
  const { stub } = await authenticatedDevice(c);
  return stub.fetch(
    "https://device/artifacts/" + encodeURIComponent(c.req.param("artifact")),
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
export default {
  fetch: api.fetch,
  async scheduled(_event, env) {
    await withDatabase(env, (db) => retryDue(db, env));
  },
};
