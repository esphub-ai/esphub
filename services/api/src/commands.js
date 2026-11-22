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
  // The device row serializes sequence allocation.
  const [row] = await db`WITH numbered AS (
    UPDATE esphub.devices SET command_seq=command_seq+1
    WHERE id=${device} AND kind='physical' AND (${boot}::text IS NULL OR boot_id=${boot})
    RETURNING command_seq
  ) INSERT INTO esphub.device_commands(device_id,seq,request_id,operation,args,boot_id,fingerprint)
    SELECT ${device},command_seq,${key},${op},${JSON.stringify(args)}::text::jsonb,${boot},${fingerprint} FROM numbered
    ON CONFLICT(device_id,request_id) DO UPDATE SET request_id=excluded.request_id
    WHERE device_commands.fingerprint=excluded.fingerprint
    RETURNING id AS command_id,state,seq AS sequence`;
  if (!row) fail(409, "Boot or request ID conflict");
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
  // One delivery, even when two callers pull concurrently or the HTTP response is lost.
  // The conditional UPDATE also rechecks state after waiting for a competing update.
  return db`WITH first AS (
    SELECT q.id,q.args FROM esphub.device_commands q JOIN esphub.devices d ON d.id=q.device_id
    WHERE d.id=${device} AND d.boot_id=${boot} AND d.enrolled_boot=${boot}
      AND (q.state='dispatched' OR (q.state='queued' AND q.expires_at>now() AND (q.boot_id IS NULL OR q.boot_id=${boot})))
    ORDER BY q.seq LIMIT 1
  ) UPDATE esphub.device_commands q SET state='dispatched',args=CASE WHEN operation='reboot' THEN q.args ELSE '{}'::jsonb END,dispatched_boot=${boot},
    next_wake=now()+CASE WHEN operation='install' THEN interval '10 minutes' ELSE interval '90 seconds' END
    FROM first WHERE q.id=first.id AND q.state='queued'
    RETURNING q.id,q.operation AS op,first.args,q.seq`;
}

export async function receipt(db, device, boot, frame) {
  const state = frame.ok ? "succeeded" : "failed";
  const result = JSON.stringify(
    frame.ok ? (frame.data ?? {}) : { error: String(frame.error ?? "Failed") },
  );
  const ack = await digest(JSON.stringify([frame.ok, JSON.parse(result)]));
  const [row] = await db`UPDATE esphub.device_commands SET
    receipt_hash=${ack},
    state=${state},result=${result}::text::jsonb,args='{}',next_wake=NULL
    WHERE device_id=${device} AND id=${frame.id} AND dispatched_boot=${boot}
    AND state IN ('dispatched','unknown') AND receipt_hash IS NULL
    RETURNING state`;
  if (row) return row;
  const [existing] =
    await db`SELECT state FROM esphub.device_commands WHERE device_id=${device}
    AND id=${frame.id} AND dispatched_boot=${boot} AND (receipt_hash=${ack} OR
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
    state=CASE WHEN state='dispatched' THEN 'unknown' WHEN expires_at<=now() THEN 'expired' ELSE 'queued' END,
    args=CASE WHEN operation='reboot' AND state='dispatched' THEN args WHEN state='dispatched' OR expires_at<=now() THEN '{}'::jsonb ELSE args END,
    next_wake=CASE WHEN state='queued' AND expires_at>now() THEN now()+interval '1 minute' END
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
