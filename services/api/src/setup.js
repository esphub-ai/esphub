// First-install device creation and credential reissue with server-generated NVS images.
import { digest, fail, token } from "./auth.js";
import { newBleSecret } from "./ble.js";
import { boardIdPattern } from "./boards.js";
import { esptoolCommand, firmwareSummary, flashPlan } from "./firmware.js";
import { buildDeviceNvs, parseWifi } from "./nvs.js";
import { provisioning } from "./provisioning.js";
import { updateSources } from "./update-sources.js";
import { uuidPattern } from "./ids.js";

const uuid = new RegExp(uuidPattern.source, "i");

async function setupPlan(db, env, board) {
  const [profile] =
    await db`SELECT * FROM esphub.board_profiles WHERE id = ${board} AND NOT retired`;
  if (!profile) fail(400, "Unknown board");
  return { profile, plan: await flashPlan(db, env.FIRMWARE, profile) };
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
async function setupResponse(c, device, profile, plan, { secret, bleSecret, wifi }) {
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
    app_version: app.version,
    files,
    command: esptoolCommand(bootloader, files),
  };
  const example = (profile.published_examples ?? []).find(
    (item) => item.id === profile.default_example,
  );
  return {
    flash,
    ...provisioning(profile, flash, example, wifi),
    ...updateSources(profile, firmwareSummary(profile.id, app, bootloader)),
  };
}

export async function createDeviceSetup(c, owner, input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "Expected a setup request object");
  for (const key of Object.keys(input))
    if (!["name", "board", "wifi"].includes(key))
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

  const db = c.sql;
  const { profile, plan } = await setupPlan(db, c.env, input.board);
  const secret = token("eh_dev_");
  const bleSecret = newBleSecret();
  const [device] =
    await db`INSERT INTO esphub.devices(owner, name, board, token_hash, ble_secret)
      VALUES (${owner}, ${input.name.trim()}, ${input.board}, ${await digest(secret)}, ${bleSecret})
      RETURNING id, name, board, kind`;
  return {
    ...device,
    hub: "api.esphub.ai",
    ...(await setupResponse(c, device, profile, plan, { secret, bleSecret, wifi })),
  };
}

export async function reissueDeviceSetup(c, owner, deviceId, input = {}) {
  if (typeof deviceId !== "string" || !uuid.test(deviceId))
    fail(400, "Invalid device_id");
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "Expected a setup reissue request object");
  for (const key of Object.keys(input))
    if (key !== "wifi") fail(400, "Unexpected " + key);
  const wifi = parseWifi(input.wifi);

  const db = c.sql;
  const [device] =
    await db`SELECT id, name, board, kind FROM esphub.devices WHERE id=${deviceId} AND owner=${owner}`;
  if (!device) fail(404, "Device not found");
  if (device.kind !== "physical")
    fail(409, "Physical device required");

  const { profile, plan } = await setupPlan(db, c.env, device.board);
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
    ...(await setupResponse(c, device, profile, plan, { secret, bleSecret, wifi })),
  };
}
