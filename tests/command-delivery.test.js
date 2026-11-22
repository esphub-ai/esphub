import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import {
  enqueue,
  pull,
  receipt,
  retryDue,
} from "../services/api/src/commands.js";

test(
  "command delivery survives missing wake, concurrent pulls and lost receipts",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = postgres(process.env.TEST_DATABASE_URL);
    const boot = crypto.randomUUID().replaceAll("-", "");
    const [owner] =
      await db`INSERT INTO esphub.accounts(handle) VALUES(${crypto.randomUUID()}) RETURNING id`;
    try {
      const [device] =
        await db`INSERT INTO esphub.devices(owner,name,board,token_hash,transport,boot_id) VALUES(${owner.id},'test','paper-color',${crypto.randomUUID()},'mqtt',${boot}) RETURNING id`;
      const c = { sql: db, env: {} },
        id = device.id,
        key = crypto.randomUUID();
      const args = { data: "hello\n" };
      const first = await enqueue(c, id, "term.write", args, boot, key);
      assert.equal(
        (await enqueue(c, id, "term.write", args, boot, key)).command_id,
        first.command_id,
      );
      await assert.rejects(
        enqueue(c, id, "term.write", { data: "changed" }, boot, key),
        (e) => e.status === 409,
      );
      const batches = await Promise.all([
        pull(db, id, boot),
        pull(db, id, boot),
      ]);
      const [command] = batches.flat();
      assert.equal(batches.flat().length, 1);
      assert.deepEqual(command.args, args);
      await db`UPDATE esphub.device_commands SET next_wake=now(),lease_until=now() WHERE id=${command.id}`;
      await retryDue(db, {}, id);
      assert.equal((await pull(db, id, boot))[0].id, command.id);
      await db`UPDATE esphub.device_commands SET state='executing',next_wake=now() WHERE id=${command.id}`;
      await retryDue(db, {}, id);
      assert.equal(
        (
          await db`SELECT state FROM esphub.device_commands WHERE id=${command.id}`
        )[0].state,
        "unknown",
      );
      assert.equal((await pull(db, id, boot)).length, 0);
      const ack = { id: command.id, ok: true, data: { bytes: 6 } };
      await assert.rejects(
        receipt(db, id, "stale", ack),
        (e) => e.status === 409,
      );
      assert.equal((await receipt(db, id, boot, ack)).state, "succeeded");
      assert.equal((await receipt(db, id, boot, ack)).state, "succeeded");
      await assert.rejects(
        receipt(db, id, boot, {
          id: command.id,
          ok: false,
          error: "conflicting result",
        }),
        (e) => e.status === 409,
      );
      const [finished] =
        await db`SELECT args,result FROM esphub.device_commands WHERE id=${command.id}`;
      assert.deepEqual(finished, { args: {}, result: ack.data });
    } finally {
      await db`DELETE FROM esphub.accounts WHERE id=${owner.id}`;
      await db.end();
    }
  },
);
