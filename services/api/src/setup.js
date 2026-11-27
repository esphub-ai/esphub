// First-install device creation and credential reissue with server-generated NVS images.
import { digest, fail, token } from "./auth.js";
import { newBleSecret } from "./ble.js";
import { boardIdPattern } from "./boards.js";
import {
  buildDeviceNvs,
  defaultNvsOffset,
  defaultNvsSize,
  PAGE_SIZE,
  parseWifi,
} from "./nvs.js";
import { provisioning } from "./provisioning.js";
import { releaseResponse } from "./releases.js";
import { updateSources } from "./update-sources.js";
import { uuidPattern } from "./ids.js";

const uuid = new RegExp(uuidPattern.source, "i");

function parseNvsPartition(manifest) {
  const rawOffset = manifest.nvs?.offset ?? manifest.nvs_offset;
  const rawSize = manifest.nvs?.size ?? manifest.nvs_size;
  const offset =
    rawOffset === undefined ? defaultNvsOffset : Number(rawOffset);
  const size = rawSize === undefined ? defaultNvsSize : Number(rawSize);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % PAGE_SIZE !== 0 ||
    !Number.isSafeInteger(size) ||
    size < 3 * PAGE_SIZE ||
    size % PAGE_SIZE !== 0
  )
    fail(503, "Board setup NVS partition layout invalid");
  return { offset, size };
}

async function resolveSetupManifest(db, env, board) {
  const [profile] = await db`SELECT b.*, r.tag AS setup_tag FROM esphub.board_profiles b
    LEFT JOIN esphub.firmware_releases r ON r.board = b.id AND r.kind = 'setup'
    WHERE b.id = ${board} AND b.is_current`;
  if (!profile) fail(400, "Unknown board");
  if (!profile.setup_tag) fail(404, "No published setup kit for this board");
  const tag = profile.setup_tag;
  const response = await releaseResponse(
    board,
    "setup-manifest",
    tag,
    db,
    env.FIRMWARE,
  );
  const manifest = await response.json();
  if (
    manifest.board !== board ||
    manifest.tag !== tag ||
    !manifest.example?.source_url
  )
    fail(503, "Board setup example unavailable");
  return { profile, tag, manifest, nvsPartition: parseNvsPartition(manifest) };
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
  const { profile, tag, manifest, nvsPartition } = await resolveSetupManifest(
    db,
    c.env,
    input.board,
  );
  const secret = token("eh_dev_");
  const bleSecret = newBleSecret();
  const [device] =
    await db`INSERT INTO esphub.devices(owner, name, board, token_hash, ble_secret)
      VALUES (${owner}, ${input.name.trim()}, ${input.board}, ${await digest(secret)}, ${bleSecret})
      RETURNING id, name, board, kind`;
  const nvsBytes = buildDeviceNvs({
    hub: "api.esphub.ai",
    token: secret,
    bleSecret,
    name: device.name,
    wifi,
    size: nvsPartition.size,
  });
  const nvs = await stageNvs(c, device.id, nvsPartition.offset, nvsBytes);
  return {
    ...device,
    hub: "api.esphub.ai",
    nvs,
    ...provisioning(profile, tag, manifest.example),
    ...updateSources(profile),
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

  const { profile, tag, manifest, nvsPartition } = await resolveSetupManifest(
    db,
    c.env,
    device.board,
  );
  const secret = token("eh_dev_");
  const bleSecret = newBleSecret();
  await db`UPDATE esphub.devices SET token_hash=${await digest(secret)},
    cert_id=NULL, cert_ready=false, cert_csr=NULL, cert_pem=NULL,
    mqtt_connected_since=NULL, boot_id=NULL, boot_info=NULL,
    ble_secret=${bleSecret} WHERE owner=${owner} AND id=${device.id}`;
  await revokeDevice(c, device.id);
  const nvsBytes = buildDeviceNvs({
    hub: "api.esphub.ai",
    token: secret,
    bleSecret,
    name: device.name,
    wifi,
    size: nvsPartition.size,
  });
  const nvs = await stageNvs(c, device.id, nvsPartition.offset, nvsBytes);
  return {
    ...device,
    hub: "api.esphub.ai",
    nvs,
    ...provisioning(profile, tag, manifest.example),
    ...updateSources(profile),
  };
}
