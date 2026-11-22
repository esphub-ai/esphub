import { fail } from "./auth.js";

const board = "virtual-esp32";
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
    INSERT INTO esphub.virtual_boots(device_id,messages)
    SELECT id,'["Virtual ESP32 created.", "Simulated firmware ready."]'::jsonb FROM registered
    ON CONFLICT (device_id,request_id) DO NOTHING
  ) SELECT * FROM registered`;
  return device;
}

export async function operateVirtual(db, device, name, args) {
  if (name === "firmware.get")
    return { kind: "virtual", process_id: device.boot_id, ...device.boot_info };
  if (name === "devices.reboot") {
    const key = args.request_id ?? crypto.randomUUID();
    // Serialize distinct reboots before allocating their history sequence.
    const [boot] = await db`WITH target AS (
      SELECT id FROM esphub.devices WHERE id=${device.id} FOR UPDATE
    ) INSERT INTO esphub.virtual_boots(device_id,request_id,messages)
      SELECT id,${key},'["Virtual ESP32 restarted.", "Simulated firmware ready."]'::jsonb FROM target
      ON CONFLICT (device_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id
      RETURNING process_id`;
    if (!boot) fail(404, "Device not found");
    return { kind: "virtual", process_id: boot.process_id };
  }
  if (name === "uart.sessions")
    return db`SELECT process_id,started_at FROM esphub.virtual_boots
      WHERE device_id=${device.id} ORDER BY sequence DESC`;
  if (name === "uart.read") {
    const [boot] = await db`SELECT started_at,messages FROM esphub.virtual_boots
      WHERE device_id=${device.id} AND process_id=${args.process_id}`;
    if (!boot) fail(404, "Unknown boot session");
    const after = args.after ?? 0;
    const records = boot.messages.slice(after).map((text, i) => ({
      seq: after + i + 1,
      at: new Date(boot.started_at).toISOString(),
      level: "I",
      text,
    }));
    return {
      records,
      cursor: records.at(-1)?.seq ?? after,
      last: boot.messages.length,
    };
  }
  fail(
    409,
    `${name} requires a physical device. Virtual ESP32 supports firmware inspection, reboot, read-only boot logs and program staging.`,
  );
}
