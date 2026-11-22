import { syncBle } from "./ble.js";
import { enroll, enabled } from "./iot.js";
import { pull, receipt, retryDue } from "./commands.js";
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
      await sql`SELECT id,board,transport,cert_id,boot_id FROM esphub.devices WHERE token_hash=${hash}`;
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
api.post("/api/device/iot/:action", async (c) => {
  const d = await authenticatedDevice(c),
    db = c.get("sql"),
    action = c.req.param("action"),
    m = await c.req.json();
  if (action === "capabilities") return c.json({ mqtt: enabled(c.env) });
  if (action === "enroll")
    return c.json(await enroll(c.env, db, d.id, d.hash, m.csr));
  if (!d.cert_id) fail(403, "Device enrollment required");
  const boot = m.boot_id;
  if (typeof boot !== "string" || !/^[0-9a-f]{32}$/.test(boot))
    fail(400, "Invalid boot ID");
  if (action === "frame" && m.t === "hello") {
    if (m.board !== d.board || !["launcher", "app"].includes(m.role))
      fail(409, "Registered board mismatch");
    const ack = await d.stub.fetch("https://device/mqtt-frame", {
      method: "POST",
      body: JSON.stringify({ frame: m, boot_id: boot, device_id: d.id }),
    });
    if (!ack.ok) return ack;
    const rows =
      await db`UPDATE esphub.devices SET boot_id=${boot},boot_info=${JSON.stringify(m)}::text::jsonb,transport='mqtt' WHERE id=${d.id} AND token_hash=${d.hash} RETURNING id`;
    if (!rows.length) fail(401, "Registration changed");
    return ack;
  }
  if (d.transport !== "mqtt" || d.boot_id !== boot)
    fail(409, "Stale device session");
  if (action === "frame" && m.t === "ble.installed")
    return c.json((await syncBle(db, d.id, d.hash, m.generation)) ?? {});
  if (action === "start") {
    if (!/^[0-9a-f-]{36}$/.test(m.id ?? "")) fail(400, "Invalid command ID");
    const rows =
      await db`UPDATE esphub.device_commands SET state='executing',lease_until=now()+interval '90 seconds',next_wake=now()+interval '90 seconds'
      WHERE device_id=${d.id} AND id=${m.id} AND claimed_boot=${boot} AND state='claimed' AND lease_until>now()
      AND NOT EXISTS(SELECT 1 FROM esphub.device_commands earlier WHERE earlier.device_id=${d.id} AND earlier.seq<device_commands.seq AND earlier.state IN ('claimed','executing') AND earlier.lease_until>now())
      AND expires_at>now() RETURNING id`;
    return c.json({ start: !!rows.length });
  }
  if (action === "pull")
    return c.json({ commands: await pull(db, d.id, boot) });
  if (action === "frame" && m.t === "res") {
    if (typeof m.ok !== "boolean" || !/^[0-9a-f-]{36}$/.test(m.id ?? ""))
      fail(400, "Invalid receipt");
    return c.json(await receipt(db, d.id, boot, m));
  }
  if (
    action === "frame" &&
    m.t === "event" &&
    ["install.done", "install.failed"].includes(m.name) &&
    /^[0-9a-f-]{36}$/.test(m.data?.transfer_id ?? "")
  ) {
    await db`UPDATE esphub.device_commands SET state=${m.name === "install.done" ? "succeeded" : "failed"},result=${JSON.stringify(m.data)}::text::jsonb,args='{}',next_wake=NULL WHERE device_id=${d.id} AND request_id=${m.data.transfer_id} AND operation='install' AND claimed_boot=${boot} AND state IN ('accepted','executing','unknown')`;
  }
  if (action === "frame" && ["log", "event", "metric"].includes(m.t))
    return d.stub.fetch("https://device/mqtt-frame", {
      method: "POST",
      body: JSON.stringify({ frame: m, boot_id: boot, device_id: d.id }),
    });
  fail(404, "Unknown action");
});
api.get("/api/device/programs/:artifact", async (c) => {
  const { stub } = await authenticatedDevice(c);
  return stub.fetch(
    "https://device/artifacts/" + encodeURIComponent(c.req.param("artifact")),
  );
});
api.get("/api/device/connect", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    fail(426, "WebSocket upgrade required");
  const { id, hash: tokenHash, stub, transport } = await authenticatedDevice(c);
  if (transport === "mqtt") {
    const db = c.get("sql");
    await db`UPDATE esphub.devices SET transport='websocket',boot_id=NULL,boot_info=NULL WHERE id=${id} AND transport='mqtt'`;
  }
  return stub.fetch("https://device/connect", {
    headers: { Upgrade: "websocket", "X-Device-ID": id, "X-Device-Token-Hash": tokenHash },
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
export default {
  fetch: api.fetch,
  async scheduled(_event, env) {
    if (enabled(env)) await withDatabase(env, (db) => retryDue(db, env));
  },
};
