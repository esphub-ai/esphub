import { releaseAsset } from "./releases.js";
import { digest, fail, token } from "./auth.js";
const strings = (...names) =>
  Object.fromEntries(names.map((n) => [n, { type: "string" }]));
const id = strings("device_id"),
  session = { ...id, ...strings("process_id") };
const defs = [
  ["devices.list", "List your registered devices.", {}],
  [
    "devices.create",
    "Register a board and issue its one-time USB provisioning token.",
    {
      ...strings("name"),
      board: { enum: ["paper-color", "stopwatch"], type: "string" },
    },
  ],
  ["devices.get", "Show device identity and live connection status.", id],
  [
    "devices.reissue",
    "Issue a replacement USB token and close the previous connection.",
    id,
  ],
  [
    "devices.delete",
    "Delete the registration and revoke the device token.",
    id,
  ],
  ["devices.reboot", "Restart the device and create a new boot session.", id],
  [
    "devices.reset",
    "Erase provisioning and saved networks on the device; USB setup is required again.",
    id,
  ],
  ["wifi.list", "Read saved Wi-Fi networks and the active connection.", id],
  ["wifi.scan", "Scan Wi-Fi networks visible to the device.", id],
  [
    "wifi.add",
    "Save a network. Omit the password for an open network.",
    { ...id, ...strings("ssid", "password") },
  ],
  ["wifi.remove", "Forget a saved network.", { ...id, ...strings("ssid") }],
  [
    "launcher.install",
    "Install the latest board-specific launcher on a connected launcher.",
    id,
  ],
  ["firmware.get", "Read firmware metadata from the board.", id],
  [
    "firmware.install",
    "Install an HTTPS application image with a verified SHA-256 digest.",
    { ...id, ...strings("url", "version", "sha256") },
  ],
  ["uart.sessions", "List boot sessions and consumed device RX cursors.", id],
  [
    "uart.read",
    "Read serial TX records after an exclusive cursor.",
    { ...session, after: { type: "integer", minimum: 0 } },
  ],
  [
    "uart.write",
    "Append a UTF-8 input record to this boot. Reuse request_id when retrying.",
    { ...session, ...strings("text", "request_id") },
  ],
];
export const tools = defs.map(([name, description, properties]) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties).filter(
      (k) => !["password", "after"].includes(k),
    ),
  },
}));
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function validate(name, a) {
  const t = tools.find((t) => t.name === name);
  if (!t) fail(404, "Unknown tool");
  if (!a || typeof a !== "object" || Array.isArray(a))
    fail(400, "Expected an arguments object");
  for (const k of t.inputSchema.required)
    if (!(k in a)) fail(400, "Missing " + k);
  for (const [k, v] of Object.entries(a)) {
    const p = t.inputSchema.properties[k];
    if (!p) fail(400, "Unexpected " + k);
    if (
      (p.type === "string" &&
        (typeof v !== "string" || !v.length || v.length > 4096)) ||
      (p.enum && !p.enum.includes(v)) ||
      (p.type === "integer" && (!Number.isSafeInteger(v) || v < 0))
    )
      fail(400, "Invalid " + k);
  }
  if (
    (a.device_id && !uuid.test(a.device_id)) ||
    (a.request_id && !uuid.test(a.request_id)) ||
    (a.process_id && !/^[0-9a-f-]{8,36}$/i.test(a.process_id))
  )
    fail(400, "Invalid identifier");
  if (
    a.name?.trim().length === 0 ||
    a.name?.length > 64 ||
    a.version?.length > 24
  )
    fail(400, "Invalid name or version");
  for (const [k, max] of [
    ["text", 1024],
    ["ssid", 32],
    ["password", 63],
  ])
    if (
      a[k] &&
      (new TextEncoder().encode(a[k]).length > max || a[k].includes("\0"))
    )
      fail(400, "Invalid " + k);
  if (a.sha256 && !/^[0-9a-f]{64}$/i.test(a.sha256))
    fail(400, "Expected a SHA-256 digest");
  if (a.url) {
    let u;
    try {
      u = new URL(a.url);
    } catch {
      fail(400, "Invalid image URL");
    }
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      a.url.length > 240
    )
      fail(400, "Use a short HTTPS image URL");
  }
}
const stub = (c, id) => c.env.DEVICE.get(c.env.DEVICE.idFromName(id));
export async function internal(c, id, path, args) {
  const r = await stub(c, id).fetch(
    "https://device/" + path,
    args ? { method: "POST", body: JSON.stringify(args) } : {},
  );
  const j = await r.json();
  if (!r.ok) fail(r.status, j.error || "Device operation failed");
  return j;
}
export async function operate(c, owner, name, a) {
  validate(name, a);
  const db = c.get("sql");
  if (name === "devices.create") {
    const secret = token("okl_dev_");
    const [d] =
      await db`INSERT INTO esphub.devices(owner,name,board,token_hash) VALUES(${owner},${a.name.trim()},${a.board},${await digest(secret)}) RETURNING id,name,board`;
    return { ...d, token: secret, hub: "api.esphub.ai" };
  }
  if (name === "devices.list") {
    const ds =
      await db`SELECT id,name,board,created_at FROM esphub.devices WHERE owner=${owner} ORDER BY created_at`;
    return await Promise.all(
      ds.map(async (d) => ({ ...d, ...(await internal(c, d.id, "summary")) })),
    );
  }
  const [d] =
    await db`SELECT id,name,board FROM esphub.devices WHERE id=${a.device_id} AND owner=${owner}`;
  if (!d) fail(404, "Device not found");
  if (name === "devices.get")
    return { ...d, ...(await internal(c, d.id, "summary")) };
  if (name === "devices.reissue") {
    const secret = token("okl_dev_");
    await db`UPDATE esphub.devices SET token_hash=${await digest(secret)} WHERE owner=${owner} AND id=${d.id}`;
    await internal(c, d.id, "revoke");
    return { token: secret };
  }
  if (name === "devices.delete") {
    await db`DELETE FROM esphub.devices WHERE id=${d.id} AND owner=${owner}`;
    await internal(c, d.id, "revoke");
    return { deleted: true };
  }
  if (name === "uart.sessions") return internal(c, d.id, "sessions");
  if (name === "uart.read")
    return internal(c, d.id, "read", {
      process_id: a.process_id,
      after: a.after ?? 0,
    });
  if (name === "uart.write") return internal(c, d.id, "write", a);
  let op,
    args = {};
  if (name.startsWith("wifi.")) {
    op = "cmd";
    args = {
      name: "wifi",
      argv: [
        name === "wifi.remove" ? "forget" : name.slice(5),
        ...[a.ssid, a.password].filter((x) => x !== undefined),
      ],
    };
  }
  if (name === "devices.reboot") {
    op = "reboot";
    args = { target: "self" };
  }
  if (name === "devices.reset") op = "provision.reset";
  if (name === "firmware.get") op = "status";
  if (name === "launcher.install") {
    const status = await internal(c, d.id, "summary");
    if (
      !status.online ||
      status.info?.role !== "launcher" ||
      status.info?.board !== d.board
    )
      fail(
        409,
        "Start a launcher reporting the registered board profile first",
      );
    const { asset, tag, version } = await releaseAsset(c.env, d.board, "ota");
    if (
      status.info.chip !== "esp32s3" ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
    )
      fail(409, "Release target or digest unavailable");
    op = "install";
    args = {
      kind: "launcher",
      board: d.board,
      url: "https://api.esphub.ai/releases/" + d.board + "/ota?tag=" + tag,
      sha256: asset.digest.slice(7),
      size: asset.size,
      version,
    };
  }
  if (name === "firmware.install") {
    op = "install";
    args = { kind: "app", url: a.url, sha256: a.sha256, version: a.version };
  }
  return (await internal(c, d.id, "rpc", { op, args })).data;
}
