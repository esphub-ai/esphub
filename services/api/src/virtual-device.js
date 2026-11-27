import { fail } from "./auth.js";

const board = "esphub/virtual-esp32";
const firmware = { name: "EspHub virtual firmware", version: "1.0.0" };
const info = { board, role: "simulator", fw: firmware };

export async function createVirtual(db, owner) {
  // Both a concurrent create and a later retry reuse the initial (NULL request) boot.
  const [device] = await db`WITH registered AS (
    INSERT INTO esphub.devices(owner,name,board,kind,token_hash,boot_info)
    VALUES (${owner},'Virtual ESP32',${board},'virtual',NULL,${JSON.stringify(info)}::text::jsonb)
    ON CONFLICT (owner) WHERE kind='virtual' DO UPDATE SET owner=EXCLUDED.owner
    RETURNING id,name,board,kind
  ), initial_boot AS (
    INSERT INTO esphub.virtual_boots(device_id)
    SELECT id FROM registered
    ON CONFLICT (device_id,request_id) DO NOTHING
  ) SELECT * FROM registered`;
  return device;
}

export async function operateVirtual(db, device, name, args) {
  if (name === "firmware_get")
    return { kind: "virtual", process_id: device.boot_id, ...device.boot_info };
  if (name === "devices_reboot") {
    const key = args.request_id ?? crypto.randomUUID();
    // Serialize distinct reboots before allocating their history sequence.
    const [boot] = await db`WITH target AS (
      SELECT id FROM esphub.devices WHERE id=${device.id} FOR UPDATE
    ) INSERT INTO esphub.virtual_boots(device_id,request_id)
      SELECT id,${key} FROM target
      ON CONFLICT (device_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id
      RETURNING process_id`;
    if (!boot) fail(404, "Device not found");
    return { kind: "virtual", process_id: boot.process_id };
  }
  fail(
    409,
    `${name} requires a physical device. Virtual ESP32 supports firmware inspection and reboot.`,
  );
}
