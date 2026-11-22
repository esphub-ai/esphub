import { softwareInventory } from "./software.js";
import { connected } from "./iot.js";
import { artifactBase } from "./uploads.js";
import boards from "../../../shared/boards.generated.json" with { type: "json" };
import { maxUploadBytes } from "./uploads.js";
import { updateSources } from "./update-sources.js";
import { provisioning } from "./provisioning.js";
import { launcherManifest } from "./releases.js";
import { digest, fail, token } from "./auth.js";
const programByteLimit = 32 * 1024;
const strings = (...names) =>
  Object.fromEntries(names.map((n) => [n, { type: "string" }]));
const id = strings("device_id"),
  session = { ...id, ...strings("process_id") };
const otaKind = { type: "string", enum: ["launcher", "micropython", "python"] };
const additive = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const readOnly = { ...additive, readOnlyHint: true };
const destructive = { ...additive, destructiveHint: true };

const defs = [
  ["devices.list", readOnly, "List your registered devices.", {}],
  [
    "devices.create",
    additive,
    "Identify the USB board first. Ask the user if uncertain. Register it and follow the returned provisioning prompt.",
    {
      ...strings("name"),
      board: { enum: Object.keys(boards), type: "string" },
    },
  ],
  [
    "devices.get",
    readOnly,
    "Show device identity, connection status and GitHub source directories for all three customizable OTA layers, even while offline.",
    id,
  ],
  [
    "devices.reissue",
    destructive,
    "Issue a replacement USB token and close the previous connection.",
    id,
  ],
  [
    "devices.delete",
    destructive,
    "Delete the registration and revoke the device token.",
    id,
  ],
  [
    "devices.reboot",
    destructive,
    "Restart the device and create a new boot session.",
    id,
  ],
  [
    "devices.reset",
    destructive,
    "Erase provisioning and saved networks on the device; USB setup is required again.",
    id,
  ],
  [
    "wifi.list",
    readOnly,
    "Read saved Wi-Fi networks and the active connection.",
    id,
  ],
  [
    "wifi.scan",
    { ...readOnly, openWorldHint: true },
    "Scan Wi-Fi networks visible to the device.",
    id,
  ],
  [
    "wifi.add",
    { ...destructive, openWorldHint: true },
    "Save a network. Omit the password for an open network.",
    { ...id, ...strings("ssid", "password") },
  ],
  [
    "wifi.remove",
    destructive,
    "Forget a saved network.",
    { ...id, ...strings("ssid") },
  ],
  [
    "launcher.install",
    { ...destructive, openWorldHint: true },
    "Install the latest board-specific launcher on a connected launcher.",
    id,
  ],
  [
    "launcher.enter",
    destructive,
    "Enter launcher mode for OTA. Wait for devices.get to report an online launcher.",
    id,
  ],
  [
    "firmware.get",
    readOnly,
    "Read live firmware metadata and get the official GitHub sources for customizing this board.",
    id,
  ],
  [
    "ota.prepare_upload",
    additive,
    "Stage a local file without GitHub or a running device. Request a short-lived, single-object R2 upload credential, then PUT exactly size bytes to upload_url with the returned headers. After HTTP 201, enter launcher mode and call ota.install with the returned url and matching kind.",
    {
      ...id,
      kind: otaKind,
      size: { type: "integer", minimum: 1, maximum: maxUploadBytes },
    },
  ],
  [
    "ota.install",
    { ...destructive, openWorldHint: true },
    "In launcher mode, stream an HTTPS artifact for the registered board. Use ota.prepare_upload for a local file. Supply your own board-compatible build or use https://api.esphub.ai/releases/{board}/ota for the official launcher or /releases/{board}/micropython for its runtime. For python, use a plain UTF-8 main.py URL. The receipt includes GitHub sources for all three layers. Follow install.done or install.failed in the returned UART session, then verify the next boot.",
    {
      ...id,
      kind: otaKind,
      url: { type: "string", maxLength: 1024 },
    },
  ],
  [
    "programs.publish",
    additive,
    "Stage main.py privately for this device for 24 hours. Pass the returned HTTPS URL to ota.install with kind python.",
    {
      ...id,
      source: {
        type: "string",
        maxLength: programByteLimit,
        description: "UTF-8 MicroPython source, up to 32 KiB.",
      },
    },
  ],
  ["programs.get", readOnly, "Read the last reported main.py for the current or last-seen MicroPython boot, including offline devices.", id],
  [
    "uart.sessions",
    readOnly,
    "List boot sessions and consumed device RX cursors.",
    id,
  ],
  [
    "uart.read",
    readOnly,
    "Read serial TX records after an exclusive cursor.",
    { ...session, after: { type: "integer", minimum: 0 } },
  ],
  [
    "uart.write",
    { ...destructive, openWorldHint: true },
    "Append a UTF-8 input record to this boot. Reuse request_id when retrying.",
    { ...session, ...strings("text", "request_id") },
  ],
  [
    "commands.get",
    readOnly,
    "Read the state and execution receipt of a queued device command.",
    { ...id, ...strings("command_id") },
  ],
];
export const tools = defs.map(
  ([name, annotations, description, properties]) => ({
    name,
    annotations,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...properties,
        ...(queueable(name) ? strings("request_id") : {}),
      },
      required: Object.keys(properties).filter(
        (k) => !["password", "after"].includes(k),
      ),
    },
  }),
);
function queueable(name) {
  return (
    name.startsWith("wifi.") ||
    [
      "devices.reboot",
      "devices.reset",
      "launcher.enter",
      "launcher.install",
      "ota.install",
      "firmware.get",
      "uart.write",
    ].includes(name)
  );
}
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
        (typeof v !== "string" ||
          !v.length ||
          v.length > (p.maxLength ?? 4096))) ||
      (p.enum && !p.enum.includes(v)) ||
      (p.type === "integer" &&
        (!Number.isSafeInteger(v) ||
          v < (p.minimum ?? 0) ||
          v > (p.maximum ?? Number.MAX_SAFE_INTEGER)))
    )
      fail(400, "Invalid " + k);
  }
  if (
    (a.command_id && !uuid.test(a.command_id)) ||
    (a.device_id && !uuid.test(a.device_id)) ||
    (a.request_id && !uuid.test(a.request_id)) ||
    (a.process_id && !/^[0-9a-f-]{8,36}$/i.test(a.process_id))
  )
    fail(400, "Invalid identifier");
  if (
    name === "ota.prepare_upload" &&
    a.kind === "python" &&
    a.size > programByteLimit
  )
    fail(400, "Artifact exceeds the size limit for this kind");
  if (a.name?.trim().length === 0 || a.name?.length > 64)
    fail(400, "Invalid name");
  for (const [k, max] of [
    ["text", 1024],
    ["source", programByteLimit],
    ["ssid", 32],
    ["password", 63],
  ])
    if (
      a[k] &&
      (new TextEncoder().encode(a[k]).length > max || a[k].includes("\0"))
    )
      fail(400, "Invalid " + k);
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
      !a.url.startsWith("https://") ||
      /[\s\\#]/.test(a.url) ||
      new TextEncoder().encode(a.url).length > 1024
    )
      fail(
        400,
        "Use an HTTPS artifact URL up to 1024 bytes without credentials or a fragment",
      );
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
async function summary(c, d) {
  if (d.transport !== "mqtt") return internal(c, d.id, "summary");
  const [online, broker] = await Promise.all([connected(c.env, d.id), internal(c, d.id, "summary")]);
  return {
    online,
    software: broker.process_id === d.boot_id ? broker.software : softwareInventory(d.boot_info),
    process_id: d.boot_id,
    info: d.boot_info,
    serial_input: true,
  };
}
export async function operate(c, owner, name, a) {
  validate(name, a);
  const db = c.sql;
  if (name === "devices.create") {
    const secret = token("okl_dev_");
    const [d] =
      await db`INSERT INTO esphub.devices(owner,name,board,token_hash) VALUES(${owner},${a.name.trim()},${a.board},${await digest(secret)}) RETURNING id,name,board`;
    return {
      ...d,
      token: secret,
      hub: "api.esphub.ai",
      ...provisioning(d.board),
      ...updateSources(d.board),
    };
  }
  if (name === "devices.list") {
    const ds =
      await db`SELECT id,name,board,created_at,transport,boot_id,boot_info FROM esphub.devices WHERE owner=${owner} ORDER BY created_at`;
    return await Promise.all(
      ds.map(async (d) => ({
        id: d.id,
        name: d.name,
        board: d.board,
        created_at: d.created_at,
        transport: d.transport,
        ...(await summary(c, d)),
      })),
    );
  }
  const [d] =
    await db`SELECT id,name,board,transport,boot_id,boot_info FROM esphub.devices WHERE id=${a.device_id} AND owner=${owner}`;
  if (!d) fail(404, "Device not found");
  const withSources = (result) => ({ ...result, ...updateSources(d.board) });
  if (name === "devices.get")
    return withSources({
      id: d.id,
      name: d.name,
      board: d.board,
      transport: d.transport,
      ...(await summary(c, d)),
    });
  if (name === "programs.get") return internal(c, d.id, "program");
  if (name === "commands.get") {
    const [row] =
      await db`SELECT id AS command_id,state,result,claimed_boot AS process_id FROM esphub.device_commands WHERE device_id=${d.id} AND id=${a.command_id}`;
    if (!row) fail(404, "Unknown command");
    return row;
  }
  if (name === "devices.reissue") {
    const secret = token("okl_dev_");
    await db`UPDATE esphub.devices SET token_hash=${await digest(secret)},cert_id=NULL,cert_ready=false,cert_csr=NULL,cert_pem=NULL,transport='websocket',boot_id=NULL,boot_info=NULL WHERE owner=${owner} AND id=${d.id}`;
    await internal(c, d.id, "revoke", { device: d.id });
    return { token: secret };
  }
  if (name === "devices.delete") {
    await db`DELETE FROM esphub.devices WHERE id=${d.id} AND owner=${owner}`;
    await internal(c, d.id, "revoke", { device: d.id });
    return { deleted: true };
  }
  if (name === "ota.prepare_upload")
    return withSources(await internal(c, d.id, "prepare-upload", a));
  if (name === "programs.publish")
    return withSources(
      await internal(c, d.id, "publish", { source: a.source }),
    );
  const key = a.request_id ?? crypto.randomUUID();
  const queue = (op, args, boot = null) =>
    internal(c, d.id, "enqueue", { device: d.id, op, args, boot, key });
  if (d.transport === "mqtt") {
    const info = d.boot_info;
    if (name === "uart.write")
      return queue("term.write", { data: a.text }, a.process_id);
    if (name === "launcher.enter")
      return info?.role === "launcher"
        ? { mode: "launcher", process_id: d.boot_id }
        : queue("reboot", { target: "launcher" }, d.boot_id);
    if (name === "ota.install") {
      if (
        info?.role !== "launcher" ||
        info.board !== d.board ||
        info.image_profile !== "ESPHUB1/launcher/" + d.board
      )
        fail(409, "Start a compatible launcher first");
      if (a.url.startsWith(artifactBase))
        await internal(c, d.id, "check-upload", { url: a.url, kind: a.kind });
      return queue(
        "install",
        { board: d.board, url: a.url, kind: a.kind, transfer_id: key },
        d.boot_id,
      );
    }
  }
  if (name === "launcher.enter")
    return withSources(await internal(c, d.id, "enter", { board: d.board }));
  if (name === "ota.install")
    return withSources(
      await internal(c, d.id, "ota", {
        board: d.board,
        kind: a.kind,
        url: a.url,
      }),
    );
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
    const status = await summary(c, d);
    if (
      !status.online ||
      status.info?.role !== "launcher" ||
      status.info?.board !== d.board
    )
      fail(
        409,
        "Start a launcher reporting the registered board profile first",
      );
    const manifest = await launcherManifest(d.board);
    if (status.info.chip !== manifest.chip)
      fail(409, "Release target mismatch");
    op = "install";
    args = {
      kind: "launcher",
      board: d.board,
      url:
        "https://api.esphub.ai/releases/" +
        d.board +
        "/ota?tag=" +
        manifest.tag,
      ...(d.transport === "mqtt" ? { transfer_id: key } : {}),
      sha256: manifest.ota.sha256,
      size: manifest.ota.size,
      version: manifest.version,
    };
  }
  if (d.transport === "mqtt")
    return queue(op, args, op === "install" ? d.boot_id : null);
  const { data } = await internal(c, d.id, "rpc", { op, args });
  return name === "firmware.get" || name === "launcher.install"
    ? withSources(data)
    : data;
}
