import { createHmac, randomBytes } from "node:crypto";
import { fail } from "./auth.js";

export function normalizeBleAddress(value) {
  return typeof value === "string" && value.length === 17 &&
    /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value) ? value.toLowerCase() : null;
}

export const newBleSecret = () => randomBytes(32).toString("hex");

export async function issueBle(sql, owner, id) {
  const [d] = await sql`SELECT ble_secret FROM esphub.devices WHERE id=${id}
    AND owner=${owner} AND kind='physical' AND ble_secret IS NOT NULL`;
  if (!d)
    fail(
      409,
      "For a registration missing BLE credentials, reissue its setup NVS image through the setup API and flash it over USB",
    );
  const psk = createHmac("sha256", Buffer.from(d.ble_secret, "hex"))
    .update("esphub/wifi/tls-psk")
    .digest("hex");
  return { psk };
}
