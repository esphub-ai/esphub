import { digest, fail } from "./auth.js";
import { publishWake, revokeCertificate } from "./iot.js";

export async function enqueue(
  c,
  device,
  op,
  args,
  boot,
  key = crypto.randomUUID(),
) {
  const db = c.sql;
  const fingerprint = await digest(
    JSON.stringify([device, key, op, args, boot]),
  );
  // The device row serializes sequence allocation and transport selection.
  const [row] = await db`WITH numbered AS (
    UPDATE esphub.devices SET command_seq=command_seq+1
    WHERE id=${device} AND transport='mqtt' AND (${boot}::text IS NULL OR boot_id=${boot})
    RETURNING command_seq
  ) INSERT INTO esphub.device_commands(device_id,seq,request_id,operation,args,boot_id,fingerprint)
    SELECT ${device},command_seq,${key},${op},${JSON.stringify(args)}::text::jsonb,${boot},${fingerprint} FROM numbered
    ON CONFLICT(device_id,request_id) DO UPDATE SET request_id=excluded.request_id
    WHERE device_commands.fingerprint=excluded.fingerprint
    RETURNING id AS command_id,state,seq AS sequence`;
  if (!row) fail(409, "Boot, transport or request ID conflict");
  if (row.state === "queued") {
    // The committed next_wake survives a failed publish or Worker exit.
    try {
      await publishWake(c.env, device);
    } catch {
      /* scheduled retry */
    }
  }
  return row;
}

export async function pull(db, device, boot) {
  // A lost pull releases the lease. Start permission is one-shot, so a lost
  // execution receipt becomes unknown without repeating the side effect.
  const rows = await db`WITH locked AS (
    SELECT id FROM esphub.devices WHERE id=${device} AND boot_id=${boot} AND transport='mqtt' FOR UPDATE
  ), pending AS (
    SELECT q.id,q.seq,q.state,octet_length(q.args::text)+256 AS bytes
    FROM esphub.device_commands q JOIN locked d ON q.device_id=d.id
    WHERE q.state IN ('queued','claimed','executing') AND q.expires_at>now() AND (q.boot_id IS NULL OR q.boot_id=${boot})
    ORDER BY q.seq LIMIT 4 FOR UPDATE OF q
  ), batch AS (
    SELECT id FROM (SELECT *, bool_and(state='queued') OVER (ORDER BY seq) AS ready,
      sum(bytes) OVER (ORDER BY seq) AS total FROM pending) ranked WHERE ready AND total<12000
  ) UPDATE esphub.device_commands q SET state='claimed', claimed_boot=${boot},
    lease_until=now()+interval '90 seconds', next_wake=now()+interval '90 seconds'
    FROM batch WHERE q.id=batch.id AND q.state='queued'
    RETURNING q.id,q.operation AS op,q.args,q.seq`;
  return rows.sort((a, b) => Number(a.seq) - Number(b.seq));
}

export async function receipt(db, device, boot, frame) {
  const state = frame.ok ? "succeeded" : "failed";
  const result = JSON.stringify(
    frame.ok ? (frame.data ?? {}) : { error: String(frame.error ?? "Failed") },
  );
  const ack = await digest(JSON.stringify([frame.ok, JSON.parse(result)]));
  const [row] = await db`UPDATE esphub.device_commands SET
    receipt_hash=${ack},
    state=CASE WHEN ${state}='succeeded' AND operation IN ('install','reboot','provision.reset') THEN 'accepted' ELSE ${state} END,
    result=${result}::text::jsonb,args=CASE WHEN operation='reboot' THEN args ELSE '{}'::jsonb END,
    next_wake=CASE WHEN ${state}='succeeded' AND operation IN ('install','reboot','provision.reset') THEN now()+interval '10 minutes' END
    WHERE device_id=${device} AND id=${frame.id} AND claimed_boot=${boot}
    AND state IN ('executing','unknown') AND receipt_hash IS NULL
    RETURNING state`;
  if (row) return row;
  const [existing] =
    await db`SELECT state FROM esphub.device_commands WHERE device_id=${device}
    AND id=${frame.id} AND claimed_boot=${boot} AND (receipt_hash=${ack} OR
      (operation='install' AND receipt_hash IS NULL AND state IN ('failed','succeeded')))`;
  if (!existing) fail(409, "Unknown or conflicting receipt");
  return existing;
}

export async function retryDue(db, env, device = null) {
  const retired =
    await db`WITH due AS (SELECT cert_id FROM esphub.iot_revocations WHERE retry_at<=now() AND (${device}::uuid IS NULL OR device_id=${device}) ORDER BY retry_at LIMIT 8 FOR UPDATE SKIP LOCKED)
    UPDATE esphub.iot_revocations r SET retry_at=now()+interval '1 minute' FROM due WHERE r.cert_id=due.cert_id RETURNING r.cert_id`;
  for (const { cert_id } of retired) {
    try {
      await revokeCertificate(env, cert_id);
      await db`DELETE FROM esphub.iot_revocations WHERE cert_id=${cert_id}`;
    } catch {
      /* retry_at remains durable */
    }
  }
  const rows = await db`WITH due AS (
    SELECT id FROM esphub.device_commands WHERE next_wake<=now() AND (${device}::uuid IS NULL OR device_id=${device})
    ORDER BY next_wake LIMIT 24 FOR UPDATE SKIP LOCKED
  ) UPDATE esphub.device_commands q SET
    state=CASE WHEN state IN ('executing','accepted') THEN 'unknown' WHEN expires_at<=now() THEN 'expired' ELSE 'queued' END,
    args=CASE WHEN state IN ('executing','accepted') OR expires_at<=now() THEN '{}'::jsonb ELSE args END,
    next_wake=CASE WHEN state IN ('queued','claimed') AND expires_at>now() THEN now()+interval '1 minute' END
    FROM due WHERE q.id=due.id RETURNING device_id,state`;
  for (const device of new Set(
    rows.filter((r) => r.state === "queued").map((r) => r.device_id),
  )) {
    try {
      await publishWake(env, device);
    } catch {
      /* next retry already recorded */
    }
  }
}

// Keep Neon idle when the fleet is idle. An active device alarm ends once its
// last command and certificate revocation are settled.
export async function nextRetry(db, device) {
  const [row] = await db`SELECT extract(epoch FROM min(due))*1000 AS at FROM
    (SELECT min(next_wake) AS due FROM esphub.device_commands WHERE device_id=${device}
     UNION ALL SELECT min(retry_at) FROM esphub.iot_revocations WHERE device_id=${device}) work`;
  return row.at ? Math.max(Date.now() + 1000, Math.ceil(Number(row.at))) : null;
}
