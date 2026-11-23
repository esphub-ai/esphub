import { softwareInventory } from "./software.js";
import { newBleSecret, issueBle } from "./ble.js";
import { connectedSince } from "./iot.js";
import { artifactBase } from "./uploads.js";
import boards from "../../../shared/boards.generated.json" with { type: "json" };
import { maxUploadBytes } from "./uploads.js";
import { updateSources } from "./update-sources.js";
import { provisioning } from "./provisioning.js";
import { bootloaderManifest } from "./releases.js";
import { digest, fail, token } from "./auth.js";
import { createVirtual, operateVirtual } from "./virtual-device.js";
const programByteLimit = 32 * 1024;
const strings = (...names) =>
  Object.fromEntries(names.map((n) => [n, { type: "string" }]));
const id = strings("device_id");
const otaKind = { type: "string", enum: ["bootloader", "micropython", "python"] };
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
    "Registers a physical device under the supplied name and board model. Returns its device ID, provisioning credentials, and board-specific setup information.",
    {
      ...strings("name"),
      board: { enum: Object.keys(boards), type: "string" },
    },
  ],
  [
    "devices.create_virtual",
    additive,
    "Create or return the account’s private Virtual ESP32 for simulated reboots and firmware inspection.",
    {},
  ],
  [
    "devices.get",
    readOnly,
    "Show device kind, identity and connection status. Physical boards include EspHub Bootloader, Runtime, and Program update guidance, official downloads, and SDK information, even while offline.",
    id,
  ],
  [
    "devices.reissue",
    destructive,
    "Issue a replacement device token and BLE bootstrap key for USB setup and close the previous connection.",
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
    "Request a restart. Some physical devices need a manual power cycle to reconnect. Check devices.get for a new online boot session.",
    id,
  ],
  [
    "devices.reset",
    destructive,
    "Erase provisioning and saved networks on the device; USB setup is required again.",
    id,
  ],
  [
    "wifi.ble_credential",
    additive,
    "Issues a private BLE Wi-Fi provisioning credential for a registered physical device with a BLE bootstrap key. Returns a beacon identifier and a pre-shared key.",
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
    "bootloader.enter",
    destructive,
    "Enter EspHub Bootloader mode for OTA updates. If already in Bootloader mode, returns the current boot session. Check devices.get for online=true and info.role=bootloader before OTA. Some boards may need a manual power cycle and may return to the app.",
    id,
  ],
  [
    "firmware.get",
    readOnly,
    "Read firmware metadata for a physical or virtual board. Physical boards also include EspHub Bootloader, Runtime, and Program update guidance and SDK information.",
    id,
  ],
  [
    "ota.prepare_upload",
    additive,
    "Returns a short-lived PUT URL, authorization headers, and an artifact URL for one file of the specified kind and byte size. A successful upload of exactly that size returns HTTP 201. The device can be offline.",
    {
      ...id,
      kind: { type: "string", enum: ["bootloader", "micropython"] },
      size: { type: "integer", minimum: 1, maximum: maxUploadBytes },
    },
  ],
  [
    "ota.install",
    { ...destructive, openWorldHint: true },
    "Update a registered device. For the latest official EspHub Bootloader, use kind bootloader and omit url. Use bootloader.enter before any OTA installation. For a Python Program, use kind python and a UTF-8 main.py URL. For a Native Program, read the SDK version and board-specific guidance from devices.get. Native Program binaries require a separate OTA path. Confirm completion from the install event and the next boot.",
    {
      ...id,
      kind: otaKind,
      url: { type: "string", maxLength: 1024 },
    },
  ],
  [
    "programs.publish",
    additive,
    "Stage main.py privately for this device for 24 hours. Physical boards can install the returned URL with ota.install. Virtual boards only stage the source.",
    {
      ...id,
      source: {
        type: "string",
        maxLength: programByteLimit,
        description: "UTF-8 MicroPython source, up to 32 KiB.",
      },
    },
  ],
  [
    "programs.get",
    readOnly,
    "Read the transfer ID, SHA-256 and byte count of the last confirmed cloud main.py installation, including offline devices.",
    id,
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
        (k) => !["password", "url"].includes(k),
      ),
    },
  }),
);
function queueable(name) {
  return (
    (name.startsWith("wifi.") && name !== "wifi.ble_credential") ||
    [
      "devices.reboot",
      "devices.reset",
      "bootloader.enter",
      "ota.install",
      "firmware.get",
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
    (a.request_id && !uuid.test(a.request_id))
  )
    fail(400, "Invalid identifier");
  if (a.name?.trim().length === 0 || a.name?.length > 64)
    fail(400, "Invalid name");
  for (const [k, max] of [
    ["source", programByteLimit],
    ["ssid", 32],
    ["password", 63],
  ])
    if (
      a[k] &&
      (new TextEncoder().encode(a[k]).length > max || a[k].includes("\0"))
    )
      fail(400, "Invalid " + k);
  if (name === "ota.install" && !a.url && a.kind !== "bootloader")
    fail(400, "Artifact URL required");
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
  if (d.kind === "virtual")
    return {
      online: true,
      process_id: d.boot_id,
      info: d.boot_info,
    };
  const [session, broker] = await Promise.all([
    d.cert_ready && d.boot_id && connectedSince(c.env, d.id),
    internal(c, d.id, "summary"),
  ]);
  return {
    online: !!session && session === Number(d.mqtt_connected_since),
    software:
      broker.process_id === d.boot_id
        ? broker.software
        : softwareInventory(d.boot_info),
    process_id: d.boot_id,
    info: d.boot_info,
  };
}
export async function operate(c, owner, name, a) {
  validate(name, a);
  const db = c.sql;
  if (name === "devices.create_virtual") return createVirtual(db, owner);
  if (name === "devices.create") {
    const secret = token("okl_dev_");
    const bleSecret = newBleSecret();
    const [d] =
      await db`INSERT INTO esphub.devices(owner,name,board,token_hash,ble_secret) VALUES(${owner},${a.name.trim()},${a.board},${await digest(secret)},${bleSecret}) RETURNING id,name,board,kind`;
    return {
      ...d,
      token: secret,
      ble_secret: bleSecret,
      hub: "api.esphub.ai",
      ...provisioning(d.board),
      ...updateSources(d.board),
    };
  }
  const ds =
    await db`SELECT d.id,d.name,d.board,d.kind,d.created_at,d.cert_ready,d.mqtt_connected_since,d.boot_info,
      CASE WHEN d.kind='virtual' THEN (
        SELECT process_id FROM esphub.virtual_boots WHERE device_id=d.id ORDER BY sequence DESC LIMIT 1
      ) ELSE d.boot_id END AS boot_id
    FROM esphub.devices d WHERE d.owner=${owner} AND (${name === "devices.list"}::boolean OR d.id=${a.device_id ?? null})
    ORDER BY d.created_at`;
  if (name === "devices.list") {
    return await Promise.all(
      ds.map(async (d) => ({
        id: d.id,
        name: d.name,
        board: d.board,
        kind: d.kind,
        created_at: d.created_at,
        transport: d.kind === "physical" ? "mqtt" : null,
        ...(await summary(c, d)),
      })),
    );
  }
  const [d] = ds;
  if (!d) fail(404, "Device not found");
  const withSources = (result) => ({ ...result, ...updateSources(d.board) });
  if (name === "devices.get")
    return {
      id: d.id,
      name: d.name,
      board: d.board,
      kind: d.kind,
      transport: d.kind === "physical" ? "mqtt" : null,
      ...(await summary(c, d)),
      ...(d.kind === "physical" ? updateSources(d.board) : {}),
    };
  if (name === "devices.delete") {
    await db`DELETE FROM esphub.devices WHERE id=${d.id} AND owner=${owner}`;
    if (d.kind === "physical")
      await internal(c, d.id, "revoke", { device: d.id });
    return { deleted: true };
  }
  if (name === "programs.publish") {
    const staged = await internal(c, d.id, "publish", {
      device_id: d.id,
      source: a.source,
    });
    return d.kind === "virtual"
      ? { ...staged, kind: "virtual", status: "staged", executable: false }
      : withSources(staged);
  }
  if (d.kind === "virtual") return operateVirtual(db, d, name, a);
  if (name === "wifi.ble_credential") return issueBle(db, owner, d.id);
  if (name === "programs.get") {
    const [installed] = await db`SELECT request_id AS transfer_id,result->>'sha256' AS sha256,
      (result->>'bytes')::integer AS bytes FROM esphub.device_commands
      WHERE device_id=${d.id} AND operation='install' AND state='succeeded' AND result->>'kind'='python'
      ORDER BY seq DESC LIMIT 1`;
    return installed ? { status: "installed", ...installed } : { status: "unreported" };
  }
  if (name === "commands.get") {
    const [row] =
      await db`SELECT id AS command_id,state,result,dispatched_boot AS process_id FROM esphub.device_commands WHERE device_id=${d.id} AND id=${a.command_id}`;
    if (!row) fail(404, "Unknown command");
    return row;
  }
  if (name === "devices.reissue") {
    const secret = token("okl_dev_");
    const bleSecret = newBleSecret();
    await db`UPDATE esphub.devices SET token_hash=${await digest(secret)}, cert_id=NULL,cert_ready=false,cert_csr=NULL,cert_pem=NULL,mqtt_connected_since=NULL,boot_id=NULL,boot_info=NULL,ble_generation=1,
      ble_secret=${bleSecret}, ble_pending=NULL, ble_pending_issued=false, ble_issued=false WHERE owner=${owner} AND id=${d.id}`;
    await internal(c, d.id, "revoke", { device: d.id });
    return { token: secret, ble_secret: bleSecret };
  }
  if (name === "ota.prepare_upload")
    return withSources(await internal(c, d.id, "prepare-upload", a));
  const key = a.request_id ?? crypto.randomUUID();
  const queue = (op, args, boot = null) =>
    internal(c, d.id, "enqueue", { device: d.id, op, args, boot, key });
  const info = d.boot_info;
  if (name === "bootloader.enter")
    return info?.role === "bootloader"
      ? { mode: "bootloader", process_id: d.boot_id }
      : queue("reboot", { target: "bootloader" }, d.boot_id);
  if (name === "ota.install") {
    const variant = boards[d.board]?.bootloader;
    const bootloader = info?.role === "bootloader" &&
      info.image_profile === "ESPHUB2/bootloader/" + variant;
    if (info?.board !== d.board || !bootloader)
      fail(409, "Enter compatible EspHub Bootloader mode first using bootloader.enter");
    if (a.kind === "bootloader" && info.dual_bootloader_ota !== true)
      fail(409, "Back up the device and install the A/B USB setup kit first");
    if (!a.url) {
      const manifest = await bootloaderManifest(db, d.board);
      if (info.chip !== manifest.chip) fail(409, "Release target mismatch");
      return queue(
        "install",
        {
          kind: "bootloader",
          board: d.board,
          transfer_id: key,
          url:
            "https://api.esphub.ai/releases/" +
            d.board +
            "/ota?tag=" +
            manifest.tag,
          sha256: manifest.ota.sha256,
          size: manifest.ota.size,
          version: manifest.version,
        },
        d.boot_id,
      );
    }
    if (a.url.startsWith(artifactBase))
      await internal(c, d.id, "check-upload", { url: a.url, kind: a.kind });
    return queue(
      "install",
      { board: d.board, url: a.url, kind: a.kind, transfer_id: key },
      d.boot_id,
    );
  }
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
  if (name === "firmware.get") return withSources(await queue("status", {}));
  return queue(op, args);
}
