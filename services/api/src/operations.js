import { apiOrigin, bootloaderUrl, releaseUrl } from "../../../shared/identity.js";
import { softwareInventory } from "./software.js";
import { issueBle } from "./ble.js";
import { connectedSince, publishDownlink } from "./iot.js";
import { appAlignment, maxAppSize, maxFlashBytes, minLittleFSBytes, validLayout } from "./layout.js";
import { artifactBase, maxUploadBytes } from "./uploads.js";
import { boardIdPattern, boardImageUrl, getBoard, searchBoards } from "./boards.js";
import { updateSources } from "./update-sources.js";
import { boardFirmware, bootloaderSet, latestBootloader } from "./firmware.js";
import { releaseFile } from "./releases.js";
import { fail } from "./auth.js";
import { createDeviceSetup } from "./setup.js";
import { createVirtual, operateVirtual } from "./virtual-device.js";
import { uuidPattern } from "./ids.js";
const strings = (...names) =>
  Object.fromEntries(names.map((n) => [n, { type: "string" }]));
const id = strings("device_id");
const otaKind = { type: "string", enum: ["bootloader", "app"] };
const bootloaderBase = apiOrigin + "/bootloaders/";
async function boardSources(db, board) {
  const profile = await getBoard(db, board);
  return updateSources(profile, (await boardFirmware(db, profile)).firmware);
}
const additive = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const readOnly = { ...additive, readOnlyHint: true };
const destructive = { ...additive, destructiveHint: true };

const defs = [
  [
    "boards_search",
    readOnly,
    "Find supported boards by a literal, case-insensitive substring of their vendor/model ID. Omit query to list all boards. Includes the default example, example capabilities, pinned source and published downloads.",
    strings("query"),
  ],
  ["devices_list", readOnly, "List your registered devices.", {}],
  [
    "devices_create",
    additive,
    "Registers a physical device with its name and group/project board ID (for example, m5stack/cardputer-adv). Ask the user for the Wi-Fi SSID and password first and pass them as wifi, so the board joins the network on first boot. Returns its device ID, a flash plan with every file of the first install (including the short-lived private NVS image), the esptool command and the installed example with its source and build command.",
    {
      ...strings("name"),
      board: { type: "string", description: "Exact board ID returned by boards_search." },
      wifi: {
        type: "object",
        description: "Wi-Fi network written into the private NVS image.",
        additionalProperties: false,
        properties: {
          ssid: { type: "string" },
          password: { type: "string" },
          hidden: { type: "boolean" },
        },
        required: ["ssid"],
      },
    },
  ],
  [
    "devices_create_virtual",
    additive,
    "Create or return the account’s private Virtual ESP32 for simulated reboots and firmware inspection.",
    {},
  ],
  [
    "devices_get",
    readOnly,
    "Show device kind, identity and connection status. For a physical board, also return the reported application identity, bootloader and app downloads, and examples with pinned source and build instructions.",
    id,
  ],
  [
    "devices_delete",
    destructive,
    "Delete the registration and revoke the device token.",
    id,
  ],
  [
    "devices_reboot",
    destructive,
    "Request a restart. Some physical devices need a manual power cycle to reconnect. Check devices_get for a new online boot session.",
    id,
  ],
  [
    "devices_reset",
    destructive,
    "Erase provisioning and saved networks on the device; USB setup is required again.",
    id,
  ],
  [
    "wifi_ble_credential",
    additive,
    "Issues a private BLE Wi-Fi provisioning credential for a registered physical device with a BLE bootstrap key. Returns the reusable TLS pre-shared key in the psk field.",
    id,
  ],
  [
    "wifi_list",
    readOnly,
    "Read saved Wi-Fi networks and the active connection.",
    id,
  ],
  [
    "wifi_scan",
    { ...readOnly, openWorldHint: true },
    "Scan Wi-Fi networks visible to the device.",
    id,
  ],
  [
    "wifi_add",
    { ...destructive, openWorldHint: true },
    "Save a network. Omit the password for an open network.",
    { ...id, ...strings("ssid", "password") },
  ],
  [
    "wifi_remove",
    destructive,
    "Forget a saved network.",
    { ...id, ...strings("ssid") },
  ],
  [
    "bootloader_enter",
    destructive,
    "Enter EspHub Bootloader mode for OTA updates. If already in Bootloader mode, returns the current boot session. Check devices_get for online=true and info.role=bootloader before OTA. Some boards may need a manual power cycle and may return to the app.",
    id,
  ],
  [
    "bootloader_exit",
    destructive,
    "Start the installed app from EspHub Bootloader mode. Verify the new app boot with devices_get.",
    id,
  ],
  [
    "firmware_get",
    readOnly,
    "Read device firmware identity, SDK version and board examples with pinned source and build instructions.",
    id,
  ],
  [
    "ota_prepare_upload",
    additive,
    "Returns a short-lived PUT URL, authorization headers, and an artifact URL for one file of the specified kind and byte size. A successful upload of exactly that size returns HTTP 201. The device can be offline.",
    {
      ...id,
      kind: otaKind,
      size: { type: "integer", minimum: 1, maximum: maxUploadBytes },
    },
  ],
  [
    "ota_install",
    { ...destructive, openWorldHint: true },
    "Install a bootloader or app in EspHub Bootloader mode. Supply an HTTPS image URL or omit it for the board’s latest published image. Verify the command receipt and the next boot.",
    {
      ...id,
      kind: otaKind,
      url: { type: "string", maxLength: 1024 },
      image_size_bytes: { type: "integer", minimum: 1, maximum: 0xffffffff,
        description: "Byte length of a third-party HTTPS image, if known. EspHub measures its own uploads and releases." },
    },
  ],
  [
    "ota_resize_app",
    destructive,
    "Grow or shrink the application slot in Launcher mode. Every size change destroys all LittleFS files. Set erase_littlefs=true only with permission to erase them. Same size is a no-op. A shrink must fit the installed image. Check the command receipt for the verified layout after reboot.",
    { ...id, app_size_bytes: { type: "integer", minimum: appAlignment, maximum: maxFlashBytes, multipleOf: appAlignment }, erase_littlefs: { type: "boolean" } },
  ],
  [
    "logs_set",
    additive,
    "Enable or disable remote ESP-IDF console output for this physical device's current boot. Capture starts off. Disabling restores local output and discards unsent bytes in the device's capture buffer. Uploaded logs remain available through logs_read. Check commands_get for the device receipt.",
    { ...id, enabled: { type: "boolean" } },
  ],
  [
    "devices_send",
    additive,
    "Send an application-defined JSON message to an online physical device. Best effort, no offline queue. Use logs_read for device messages and optional replies.",
    {
      ...id,
      payload: { description: "Any JSON value, up to 1024 UTF-8 bytes." },
    },
  ],
  [
    "logs_read",
    readOnly,
    "Read console output and device events in arrival order, including offline. Defaults to the latest boot. Pass the returned process_id and cursor as after to continue.",
    {
      ...id, ...strings("process_id"),
      after: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 64 },
    },
  ],
  [
    "commands_get",
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
        (k) => name === "logs_read" ? k === "device_id" : !["password", "url", "query", "erase_littlefs", "image_size_bytes", "wifi"].includes(k),
      ),
    },
  }),
);
function queueable(name) {
  return (
    (name.startsWith("wifi_") && name !== "wifi_ble_credential") ||
    [
      "devices_reboot",
      "devices_reset",
      "bootloader_enter",
      "bootloader_exit",
      "ota_install",
      "ota_resize_app",
      "logs_set",
      "firmware_get",
    ].includes(name)
  );
}
// Accept either case from callers; Postgres compares UUIDs case-insensitively.
const uuid = new RegExp(uuidPattern.source, "i");
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
      (p.type === "boolean" && typeof v !== "boolean") ||
      (p.enum && !p.enum.includes(v)) ||
      (p.type === "integer" &&
        (!Number.isSafeInteger(v) ||
          v < (p.minimum ?? 0) ||
          v > (p.maximum ?? Number.MAX_SAFE_INTEGER) || (p.multipleOf && v % p.multipleOf !== 0)))
    )
      fail(400, "Invalid " + k);
  }
  if (
    (a.process_id && !/^[a-f0-9]{32}$/.test(a.process_id)) ||
    (a.command_id && !uuid.test(a.command_id)) ||
    (a.device_id && !uuid.test(a.device_id)) ||
    (a.request_id && !uuid.test(a.request_id))
  )
    fail(400, "Invalid identifier");
  if (a.board && !boardIdPattern.test(a.board)) fail(400, "Invalid board");
  if (a.name?.trim().length === 0 || a.name?.length > 64)
    fail(400, "Invalid name");
  for (const [k, max] of [
    ["ssid", 32],
    ["password", 63],
  ])
    if (
      a[k] &&
      (new TextEncoder().encode(a[k]).length > max || a[k].includes("\0"))
    )
      fail(400, "Invalid " + k);
  if (name === "ota_prepare_upload" && a.kind === "bootloader" && a.size > 4 * 1024 * 1024)
    fail(400, "Bootloader upload exceeds 4 MiB");
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
async function internal(c, id, path, args) {
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
    ble_address: d.ble_address,
    online: !!session && session === Number(d.mqtt_connected_since),
    software:
      broker.process_id === d.boot_id
        ? broker.software
        : softwareInventory(d.boot_info),
    process_id: d.boot_id,
    info: d.boot_info ? { role: d.boot_info.role, net_mac: d.boot_info.net_mac ?? null,
      ...(validLayout(d.boot_info.layout) ? { layout: d.boot_info.layout } : {}) } : null,
  };
}
export async function operate(c, owner, name, a) {
  validate(name, a);
  const db = c.sql;
  if (name === "boards_search") return searchBoards(db, a.query);
  if (name === "devices_create_virtual") return createVirtual(db, owner);
  if (name === "devices_create") {
    return createDeviceSetup(c, owner, {
      name: a.name,
      board: a.board,
      ...(a.wifi !== undefined && { wifi: a.wifi }),
    });
  }
  const ds =
    await db`SELECT d.id,d.name,d.board,d.kind,d.ble_address,d.created_at,d.cert_ready,d.mqtt_connected_since,d.boot_info,
      CASE WHEN d.kind='virtual' THEN (
        SELECT process_id FROM esphub.virtual_boots WHERE device_id=d.id ORDER BY sequence DESC LIMIT 1
      ) ELSE d.boot_id END AS boot_id
    FROM esphub.devices d WHERE d.owner=${owner} AND (${name === "devices_list"}::boolean OR d.id=${a.device_id ?? null})
    ORDER BY d.created_at`;
  if (name === "devices_list") {
    return await Promise.all(
      ds.map(async (d) => ({
        id: d.id,
        name: d.name,
        board: d.board,
        kind: d.kind,
        ...(d.kind === "physical" && { image_url: boardImageUrl(d.board) }),
        created_at: d.created_at,
        ...(await summary(c, d)),
      })),
    );
  }
  const [d] = ds;
  if (!d) fail(404, "Device not found");
  if (name === "devices_get")
    return {
      id: d.id,
      name: d.name,
      board: d.board,
      kind: d.kind,
      ...(await summary(c, d)),
      ...(d.kind === "physical" ? await boardSources(db, d.board) : {}),
    };
  if (name === "devices_delete") {
    await db`DELETE FROM esphub.devices WHERE id=${d.id} AND owner=${owner}`;
    if (d.kind === "physical")
      await internal(c, d.id, "revoke", { device: d.id });
    return { deleted: true };
  }
  if (name === "devices_send") {
    const payload = JSON.stringify(a.payload);
    if (
      payload === undefined ||
      new TextEncoder().encode(payload).length > 1024
    )
      fail(400, "Invalid payload");
    if (d.kind !== "physical") fail(400, "Physical device required");
    const session =
      d.cert_ready && d.boot_id ? await connectedSince(c.env, d.id) : null;
    if (session === null || session !== Number(d.mqtt_connected_since))
      fail(409, "Device offline");
    const message_id = crypto.randomUUID();
    await publishDownlink(
      c.env,
      d.id,
      {
        boot_id: d.boot_id,
        message: { id: message_id, payload: a.payload },
      },
      0,
    );
    return { message_id };
  }
  if (d.kind === "virtual") return operateVirtual(db, d, name, a);
  if (name === "wifi_ble_credential") return issueBle(db, owner, d.id);
  if (name === "logs_read") return internal(c, d.id, "logs", a);
  if (name === "commands_get") {
    const [row] =
      await db`SELECT id AS command_id,state,result,dispatched_boot AS process_id FROM esphub.device_commands WHERE device_id=${d.id} AND id=${a.command_id}`;
    if (!row) fail(404, "Unknown command");
    return row;
  }
  if (name === "ota_prepare_upload")
    return internal(c, d.id, "prepare-upload", a);
  const key = a.request_id ?? crypto.randomUUID();
  const queue = (op, args, boot = null) =>
    internal(c, d.id, "enqueue", { device: d.id, op, args, boot, key });
  if (name === "logs_set") {
    if (!d.boot_id) fail(409, "A device boot is required for log capture");
    return queue("logs.set", { enabled: a.enabled }, d.boot_id);
  }
  const info = d.boot_info;
  if (name === "bootloader_enter")
    return info?.role === "bootloader"
      ? { mode: "bootloader", process_id: d.boot_id }
      : queue("reboot", { target: "bootloader" }, d.boot_id);
  if (name === "bootloader_exit") {
    if (info?.role !== "bootloader" || !d.boot_id) fail(409, "Device must be in bootloader mode");
    return queue("reboot", { target: "app" }, d.boot_id);
  }
  if (name === "ota_resize_app") {
    if (info?.role !== "bootloader" || !d.boot_id)
      fail(409, "Enter EspHub Bootloader mode before resizing the app slot");
    if (!validLayout(info.layout))
      fail(409, "Launcher layout unavailable. Update the Launcher or query its firmware status and wait for the receipt.");
    const { app_size_bytes: current, data_size_bytes: filesystem } = info.layout;
    const data = current + filesystem - a.app_size_bytes;
    if (data < minLittleFSBytes) fail(400, "Target exceeds available app and LittleFS capacity");
    if (a.app_size_bytes !== current && a.erase_littlefs !== true)
      fail(400, "Changing the app slot erases LittleFS. Set erase_littlefs=true to authorize.");
    return queue("resize_app", {
      app_size_bytes: a.app_size_bytes, data_size_bytes: data, erase_littlefs: a.erase_littlefs === true,
      transfer_id: key,
    }, d.boot_id);
  }
  if (name === "ota_install") {
    if (info?.role !== "bootloader")
      fail(409, "Enter EspHub Bootloader mode first using bootloader_enter");
    let url = a.url, imageSize = a.image_size_bytes;
    if (url?.startsWith(artifactBase)) {
      ({ size: imageSize } = await internal(c, d.id, "check-upload", { url, kind: a.kind }));
    } else if (a.kind === "app" && (!url || url.split("?")[0] === releaseUrl(d.board, "app"))) {
      const tag = (url && new URL(url).searchParams.get("tag")) || undefined;
      const file = await releaseFile(db, d.board, tag);
      imageSize = file.size ?? (await c.env.FIRMWARE.head(file.object_key))?.size;
      url = releaseUrl(d.board, "app", file.tag);
    } else if (a.kind === "bootloader" && (!url || url.startsWith(bootloaderBase))) {
      const { bootloader: id } = await getBoard(db, d.board);
      const [, version, file] = url ? url.slice(bootloaderBase.length).split("/") : [];
      if (url && (url !== bootloaderUrl(id, version, file) || file !== "launcher"))
        fail(400, "Use this board's published Launcher or an uploaded image");
      const launcher = url ? await bootloaderSet(db, id, version) : await latestBootloader(db, id);
      if (!launcher) fail(url ? 404 : 503, "No bootloader is published for this board yet");
      imageSize = launcher.launcher_size;
      url = bootloaderUrl(launcher.id, launcher.version, "launcher");
    }
    if (a.kind === "app" && validLayout(info.layout) && imageSize > info.layout.app_size_bytes)
      fail(409, `Image ${imageSize} bytes, app slot ${info.layout.app_size_bytes}, maximum after resize ${maxAppSize(info.layout)}`);
    const args = {
      url, kind: a.kind, transfer_id: key, ...(imageSize ? { image_size: imageSize } : {}),
    };
    return queue("install", args, d.boot_id);
  }
  let op,
    args = {};
  if (name.startsWith("wifi_")) {
    op = "cmd";
    args = {
      name: "wifi",
      argv: [
        name === "wifi_remove" ? "forget" : name.slice(5),
        ...[a.ssid, a.password].filter((x) => x !== undefined),
      ],
    };
  }
  if (name === "devices_reboot") {
    op = "reboot";
    args = { target: "self" };
  }
  if (name === "devices_reset") op = "provision.reset";
  if (name === "firmware_get") {
    const [sources, state] = await Promise.all([boardSources(db, d.board), summary(c, d)]);
    return { ...await queue("status", {}), software: state.software, ...sources };
  }
  return queue(op, args);
}
