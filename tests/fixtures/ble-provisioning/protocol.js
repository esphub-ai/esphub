// Simulation only. Secret state represents hub storage or device NVS, never a BLE payload.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const nonceBytes = 12;
const tagBytes = 12;

function derive(secret, purpose, nonce) {
  return createHmac("sha256", secret)
    .update("esphub/wifi/v1/" + purpose + "\0")
    .update(nonce)
    .digest();
}

// Models an owner-authorized MCP call; the host receives only the two return values.
export function issueCredential({ secret, pending }) {
  if (pending) throw Error("rotation pending");
  const nonce = randomBytes(nonceBytes);
  const tag = derive(secret, "beacon", nonce).subarray(0, tagBytes);
  return {
    beacon: Buffer.concat([nonce, tag]),
    psk: derive(secret, "session", nonce),
  };
}

export function recognizeBeacon(secret, beacon) {
  if (beacon.length !== nonceBytes + tagBytes) return null;
  const nonce = beacon.subarray(0, nonceBytes);
  const expected = derive(secret, "beacon", nonce).subarray(0, tagBytes);
  if (!timingSafeEqual(expected, beacon.subarray(nonceBytes))) return null;
  return derive(secret, "session", nonce);
}

export function register() {
  return { generation: 1, secret: randomBytes(32) };
}

// These operations travel over the authenticated hub channel after Wi-Fi is up.
// Each returned state replaces a single durable record atomically in the model.
export function prepareRotation(hub) {
  if (hub.pending) return hub;
  return {
    ...hub,
    pending: { generation: hub.generation + 1, secret: randomBytes(32) },
  };
}

export function installRotation(device, next) {
  if (
    next.generation === device.generation &&
    next.secret.equals(device.secret)
  )
    return device;
  if (next.generation !== device.generation + 1)
    throw Error("unexpected generation");
  return { generation: next.generation, secret: Buffer.from(next.secret) };
}

export function acknowledgeRotation(hub, installedGeneration) {
  if (installedGeneration === hub.generation) return hub;
  if (hub.pending?.generation !== installedGeneration)
    throw Error("unexpected acknowledgement");
  return hub.pending;
}
