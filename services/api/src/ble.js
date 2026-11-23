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
  const [d] = await sql`UPDATE esphub.devices SET ble_issued=true,
    ble_pending_issued=(ble_pending IS NOT NULL) WHERE id=${id}
    AND owner=${owner} AND kind='physical' AND ble_secret IS NOT NULL
    RETURNING ble_secret, ble_pending`;
  if (!d)
    fail(
      409,
      "For a registration missing BLE credentials, use devices.reissue and write the new token and ble_secret over USB",
    );
  const current = await credential(d.ble_secret);
  if (d.ble_pending) current.alternate = await credential(d.ble_pending);
  return current;
}

// The authenticated device reports its durably installed generation after reconnect.
// A lost offer or confirmation is retried using the same pending key.
export async function syncBle(sql, id, tokenHash, generation) {
  if (
    !tokenHash ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation >= 2147483647
  )
    return;
  await sql`UPDATE esphub.devices SET ble_secret=ble_pending, ble_pending=NULL,
    ble_generation=ble_generation+1, ble_issued=ble_pending_issued, ble_pending_issued=false WHERE id=${id} AND token_hash=${tokenHash} AND ble_pending IS NOT NULL
    AND ble_generation=${generation - 1} RETURNING id`;
  const [next] =
    await sql`UPDATE esphub.devices SET ble_pending=COALESCE(ble_pending,${newBleSecret()})
    WHERE id=${id} AND token_hash=${tokenHash} AND ble_generation=${generation} AND ble_issued=true
    RETURNING ble_pending, ble_generation`;
  if (next)
    return {
      t: "ble.rotate",
      generation: generation + 1,
      secret: next.ble_pending,
    };
}
