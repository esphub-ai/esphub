import { digest, fail } from "./auth.js";
import { publishWake } from "./iot.js";

export async function enqueue(c, device, op, args, boot, key = crypto.randomUUID()) {
  const db = c.sql;
  const fingerprint = await digest(JSON.stringify([op, args, boot]));
  // The device row serializes sequence allocation and transport selection.
  const [row] = await db`WITH numbered AS (
    UPDATE esphub.devices SET command_seq=command_seq+1
    WHERE id=${device} AND transport='mqtt' AND (${boot}::text IS NULL OR boot_id=${boot})
    RETURNING command_seq
  ) INSERT INTO esphub.device_commands(device_id,seq,request_id,operation,args,boot_id,fingerprint)
    SELECT ${device},command_seq,${key},${op},${JSON.stringify(args)}::jsonb,${boot},${fingerprint} FROM numbered
    ON CONFLICT(device_id,request_id) DO UPDATE SET request_id=excluded.request_id
    WHERE device_commands.fingerprint=excluded.fingerprint
    RETURNING id AS command_id,state,seq AS sequence`;
  if (!row) fail(409, "Boot, transport or request ID conflict");
  if (row.state === "queued") {
    // The committed next_wake survives a failed publish or Worker exit.
    try { await publishWake(c.env, device); } catch { /* scheduled retry */ }
  }
  return row;
}

export async function pull(db, device, boot) {
  // Lease a contiguous batch once. Delivered operations are never silently replayed.
  // A lost reply is observable as unknown after the lease. Only untouched rows expire.
  const rows = await db`WITH locked AS (
    SELECT id FROM esphub.devices WHERE id=${device} AND boot_id=${boot} AND transport='mqtt' FOR UPDATE
  ), batch AS (
    SELECT q.id FROM esphub.device_commands q JOIN locked d ON q.device_id=d.id
    WHERE q.state='queued' AND q.expires_at>now() AND (q.boot_id IS NULL OR q.boot_id=${boot})
    AND NOT EXISTS (SELECT 1 FROM esphub.device_commands p WHERE p.device_id=d.id AND p.state IN ('claimed','executing') AND p.lease_until>now())
    ORDER BY q.seq LIMIT 4 FOR UPDATE OF q
  ) UPDATE esphub.device_commands q SET state='claimed', claimed_boot=${boot},
    lease_until=now()+interval '90 seconds', next_wake=now()+interval '90 seconds'
    FROM batch WHERE q.id=batch.id AND q.state='queued'
    RETURNING q.id,q.operation AS op,q.args,q.seq`;
  return rows.sort((a,b)=>Number(a.seq)-Number(b.seq));
}

export async function receipt(db, device, boot, frame) {
  const state = frame.ok ? "succeeded" : "failed";
  const result = JSON.stringify(frame.ok ? frame.data ?? {} : {error: String(frame.error ?? "Failed")});
  const [row] = await db`UPDATE esphub.device_commands SET
    state=CASE WHEN ${state}='succeeded' AND operation IN ('install','reboot','provision.reset') THEN 'accepted' ELSE ${state} END,
    result=${result}::jsonb,args='{}',next_wake=NULL
    WHERE device_id=${device} AND id=${frame.id} AND claimed_boot=${boot}
    AND (state IN ('executing','unknown') OR (state IN ('succeeded','failed','accepted') AND result=${result}::jsonb))
    RETURNING state`;
  if (!row) fail(409, "Unknown or conflicting receipt");
  return row;
}

export async function retryDue(db,env) {
  const rows = await db`WITH due AS (
    SELECT id FROM esphub.device_commands WHERE next_wake<=now()
    ORDER BY next_wake LIMIT 256 FOR UPDATE SKIP LOCKED
  ) UPDATE esphub.device_commands q SET
    state=CASE WHEN state='executing' THEN 'unknown' WHEN expires_at<=now() THEN 'expired' ELSE 'queued' END,
    args=CASE WHEN state='executing' OR expires_at<=now() THEN '{}'::jsonb ELSE args END,
    next_wake=CASE WHEN state IN ('queued','claimed') AND expires_at>now() THEN now()+interval '1 minute' END
    FROM due WHERE q.id=due.id RETURNING device_id,state`;
  for (const device of new Set(rows.filter(r=>r.state==='queued').map(r=>r.device_id))) {
    try { await publishWake(env,device); } catch { /* next retry already recorded */ }
  }
}
