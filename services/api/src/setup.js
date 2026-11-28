// First-install device creation and credential reissue with server-generated NVS images.
import { projectAppUrl } from "../../../shared/identity.js";
import { digest, fail, token } from "./auth.js";
import { newBleSecret } from "./ble.js";
import { boardIdPattern, boardSpec } from "./boards.js";
import { esptoolCommand, firmwareSummary, flashPlan, versionPattern } from "./firmware.js";
import { buildDeviceNvs, parseWifi } from "./nvs.js";
import { projectAppFile, signProjectAppUrl } from "./projects.js";
import { provisioning } from "./provisioning.js";
import { uuidPattern } from "./ids.js";

const uuid = new RegExp(uuidPattern.source, "i");

function parseProjectTarget(input) {
  if (input.project_id === undefined) {
    if (input.version !== undefined) fail(400, "version requires project_id");
    return null;
  }
  if (typeof input.project_id !== "string" || !uuid.test(input.project_id))
    fail(400, "Invalid project_id");
  if (
    input.version !== undefined &&
    (typeof input.version !== "string" || !versionPattern.test(input.version))
  )
    fail(400, "Invalid version");
  return { projectId: input.project_id.toLowerCase(), version: input.version };
}

async function setupPlan(db, env, boardId, projectTarget, owner) {
  const [board] =
    await db`SELECT * FROM esphub.boards WHERE id = ${boardId} AND NOT retired`;
  if (!board) fail(400, "Unknown board");
  const app = projectTarget
    ? await projectAppFile(db, projectTarget.projectId, board.id, projectTarget.version, {
        owner,
      })
    : null;
  const plan = await flashPlan(db, env.FIRMWARE, board, app);
  if (app && app.visibility !== "public") {
    const signedUrl = await signProjectAppUrl(env.IOT_RELAY_SECRET, {
      projectId: app.project_id,
      boardId: app.board_id,
      version: app.version,
    });
    plan.appSignedUrl = signedUrl;
    plan.files = plan.files.map((file) =>
      file.name === "app.bin" ? { ...file, url: signedUrl } : file,
    );
  }
  return { board, plan };
}

async function stageNvs(c, deviceId, offset, bytes) {
  const stub = c.env.DEVICE.get(c.env.DEVICE.idFromName(deviceId));
  const response = await stub.fetch(
    `https://device/stage-nvs?device=${encodeURIComponent(deviceId)}&offset=${offset}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    },
  );
  const json = await response.json();
  if (!response.ok) fail(response.status, json.error || "NVS staging failed");
  return json;
}

async function revokeDevice(c, deviceId) {
  const stub = c.env.DEVICE.get(c.env.DEVICE.idFromName(deviceId));
  const response = await stub.fetch("https://device/revoke", {
    method: "POST",
    body: JSON.stringify({ device: deviceId }),
  });
  const json = await response.json();
  if (!response.ok) fail(response.status, json.error || "Device revoke failed");
  return json;
}

// Stage the device's private NVS image and describe every file of the first install.
async function setupResponse(c, device, board, plan, { secret, bleSecret, wifi }) {
  const { bootloader, app } = plan;
  const nvsBytes = buildDeviceNvs({
    hub: "api.esphub.ai",
    token: secret,
    bleSecret,
    wifi,
    size: bootloader.nvs_size,
  });
  const nvs = await stageNvs(c, device.id, bootloader.nvs_offset, nvsBytes);
  const files = [
    ...plan.files,
    {
      name: "nvs.bin",
      offset: nvs.offset,
      url: nvs.url,
      headers: nvs.headers,
      sha256: nvs.sha256,
      size: nvs.size,
      expires_at: nvs.expires_at,
    },
  ].sort((a, b) => Number(a.offset) - Number(b.offset));
  const flash = {
    chip: bootloader.chip,
    flash_mode: bootloader.flash_mode,
    flash_size: bootloader.flash_size,
    flash_freq: bootloader.flash_freq,
    bootloader: { id: bootloader.id, version: bootloader.version },
    ...(app && {
      project: {
        id: app.project_id,
        version: app.version,
        download_url:
          plan.appSignedUrl ??
          projectAppUrl(app.project_id, app.board_id, app.version),
      },
    }),
    files,
    command: esptoolCommand(bootloader, files),
  };
  return {
    spec: boardSpec(board),
    flash,
    firmware: firmwareSummary(bootloader),
    ...provisioning(board, flash, { wifi, hasApp: Boolean(app) }),
  };
}

export async function createDeviceSetup(c, owner, input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "Expected a setup request object");
  for (const key of Object.keys(input))
    if (!["name", "board", "wifi", "project_id", "version"].includes(key))
      fail(400, "Unexpected " + key);
  if (
    typeof input.name !== "string" ||
    !input.name.trim().length ||
    input.name.length > 64
  )
    fail(400, "Invalid name");
  if (typeof input.board !== "string" || !boardIdPattern.test(input.board))
    fail(400, "Invalid board");
  const wifi = parseWifi(input.wifi);
  const projectTarget = parseProjectTarget(input);

  const db = c.sql;
  const { board, plan } = await setupPlan(db, c.env, input.board, projectTarget, owner);
  const secret = token("eh_dev_");
  const bleSecret = newBleSecret();
  const [device] =
    await db`INSERT INTO esphub.devices(owner, name, board, token_hash, ble_secret)
      VALUES (${owner}, ${input.name.trim()}, ${input.board}, ${await digest(secret)}, ${bleSecret})
      RETURNING id, name, board, kind`;
  return {
    ...device,
    hub: "api.esphub.ai",
    ...(await setupResponse(c, device, board, plan, { secret, bleSecret, wifi })),
  };
}

export async function reissueDeviceSetup(c, owner, deviceId, input = {}) {
  if (typeof deviceId !== "string" || !uuid.test(deviceId))
    fail(400, "Invalid device_id");
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "Expected a setup reissue request object");
  for (const key of Object.keys(input))
    if (!["wifi", "project_id", "version"].includes(key))
      fail(400, "Unexpected " + key);
  const wifi = parseWifi(input.wifi);
  const projectTarget = parseProjectTarget(input);

  const db = c.sql;
  const [device] =
    await db`SELECT id, name, board, kind FROM esphub.devices WHERE id=${deviceId} AND owner=${owner}`;
  if (!device) fail(404, "Device not found");
  if (device.kind !== "physical")
    fail(409, "Physical device required");

  const { board, plan } = await setupPlan(db, c.env, device.board, projectTarget, owner);
  const secret = token("eh_dev_");
  const bleSecret = newBleSecret();
  await db`UPDATE esphub.devices SET token_hash=${await digest(secret)},
    cert_id=NULL, cert_ready=false, cert_csr=NULL, cert_pem=NULL,
    mqtt_connected_since=NULL, boot_id=NULL, boot_info=NULL,
    ble_secret=${bleSecret} WHERE owner=${owner} AND id=${device.id}`;
  await revokeDevice(c, device.id);
  return {
    ...device,
    hub: "api.esphub.ai",
    ...(await setupResponse(c, device, board, plan, { secret, bleSecret, wifi })),
  };
}
