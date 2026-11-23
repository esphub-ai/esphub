import { fail } from "./auth.js";

const hex = (bytes) =>
  Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
export const newBleSecret = () =>
  hex(crypto.getRandomValues(new Uint8Array(32)));

export async function credential(
  secret,
  nonce = crypto.getRandomValues(new Uint8Array(8)),
) {
  const raw = Uint8Array.from(secret.match(/../g), (x) => parseInt(x, 16));
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  async function mac(label) {
    const prefix = new TextEncoder().encode(
      "esphub/wifi/uuid-v1/" + label + "\0",
    );
    return new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new Uint8Array([...prefix, ...nonce]),
      ),
    );
  }
  return {
    beacon: hex(nonce) + hex((await mac("beacon")).slice(0, 8)),
    psk: hex(await mac("session")),
  };
}

export async function issueBle(sql, owner, id) {
  const [d] = await sql`SELECT ble_secret FROM esphub.devices WHERE id=${id}
    AND owner=${owner} AND kind='physical' AND ble_secret IS NOT NULL`;
  if (!d)
    fail(
      409,
      "For a registration missing BLE credentials, use devices.reissue and write the new token and ble_secret over USB",
    );
  return credential(d.ble_secret);
}
