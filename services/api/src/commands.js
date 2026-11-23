import { digest, fail } from "./auth.js";
import { connectedSince, publishDownlink, revokeCertificate } from "./iot.js";

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
  if (row.state === "queued") await dispatch(c.sql, c.env, device);
  return row;
}

// A device has one outstanding command. Keep its body until a receipt or timeout
// so a lost QoS 1 publication can be repeated with the same boot, ID and sequence.
export async function claimCommand(db, device, boot, reconnect = false) {
  return db`WITH current_device AS (
    SELECT id FROM esphub.devices WHERE id=${device} AND boot_id=${boot} FOR UPDATE
  ), first AS (
    SELECT q.id FROM esphub.device_commands q JOIN current_device d ON d.id=q.device_id
    WHERE q.state='dispatched' OR (q.state='queued' AND q.expires_at>now() AND (q.boot_id IS NULL OR q.boot_id=${boot}))
    ORDER BY q.seq LIMIT 1
  ) UPDATE esphub.device_commands q SET state='dispatched',dispatched_boot=${boot},
    delivery_deadline=COALESCE(delivery_deadline,now()+CASE WHEN operation='install' THEN interval '10 minutes' ELSE interval '90 seconds' END),
    next_wake=least(delivery_deadline,now()+interval '15 seconds')
    FROM first WHERE q.id=first.id AND (q.state='queued' OR
      (q.state='dispatched' AND q.dispatched_boot=${boot} AND q.delivery_deadline>now()
       AND ${reconnect}))
    RETURNING q.id,q.operation AS op,q.args,q.seq`;
}

export async function dispatch(
  db,
  env,
  device,
  boot = null,
  reconnect = false,
) {
  // The next attempt is already committed. A broker outage must not turn a
  // persisted enqueue or the preceding command's receipt into a failed request.
  try {
    if (!boot) {
      const session = await connectedSince(env, device);
      if (!session) return;
      const [d] =
        await db`SELECT boot_id FROM esphub.devices WHERE id=${device} AND cert_ready
        AND mqtt_connected_since=${session}`;
      if (!d?.boot_id) return;
      boot = d.boot_id;
    }
    const [command] = await claimCommand(db, device, boot, reconnect);
    if (command)
      await publishDownlink(env, device, {
        boot_id: boot,
        command: { ...command, seq: Number(command.seq) },
      });
  } catch {
    console.warn("MQTT command delivery deferred", device);
  }
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
    AND (operation<>'install' OR NOT ${frame.ok})
    RETURNING state`;
  if (row) return row;
  const [existing] =
    await db`SELECT state FROM esphub.device_commands WHERE device_id=${device}
    AND id=${frame.id} AND dispatched_boot=${boot} AND receipt_hash=${ack}`;
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
    state=CASE WHEN state='dispatched' AND delivery_deadline<=now() THEN 'unknown'
               WHEN state='queued' AND expires_at<=now() THEN 'expired' ELSE state END,
    args=CASE WHEN (state='dispatched' AND delivery_deadline<=now() AND operation<>'reboot')
                OR (state='queued' AND expires_at<=now()) THEN '{}'::jsonb ELSE args END,
    next_wake=CASE WHEN state='dispatched' AND delivery_deadline>now() THEN least(delivery_deadline,now()+interval '15 seconds')
                   WHEN state='queued' AND expires_at>now() THEN now()+interval '1 minute' END
    FROM due WHERE q.id=due.id RETURNING device_id,state`;
  for (const id of new Set(rows.map((r) => r.device_id))) {
    const retry = rows.some(
      (r) => r.device_id === id && r.state === "dispatched",
    );
    await dispatch(db, env, id, null, retry);
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
