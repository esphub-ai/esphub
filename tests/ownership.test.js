import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { recordRelease, setupRelease, jsonBucket } from "./fixtures/setup-release.mjs";
import { operate } from "../services/api/src/operations.js";
import { digest } from "../services/api/src/auth.js";
test(
  "new registrations store only a token hash and cannot cross account boundaries",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
    try {
      const rollback = new Error("Roll back ownership test data");
      await assert.rejects(sql.begin(async (tx) => {
        const users =
          await tx`INSERT INTO esphub.accounts SELECT FROM generate_series(1, 2) RETURNING id`;
        const board = "m5stack/cardputer-adv";
        const [profile] = await tx`SELECT * FROM esphub.board_profiles WHERE id = ${board}`;
        const release = setupRelease(board, profile);
        await recordRelease(tx, release);
        const { files } = release;
        const c = {
          sql: tx,
          env: {
            FIRMWARE: jsonBucket(files),
            DEVICE: {
              idFromName: (id) => id,
              get: () => ({ fetch: () => Response.json({}) }),
            },
          },
        };
        const args = { board: "m5stack/cardputer-adv", name: "Cardputer-Adv" },
          d = await operate(c, users[0].id, "devices_create", args);
        assert.equal(
          (await tx`SELECT token_hash FROM esphub.devices WHERE id=${d.id}`)[0]
            .token_hash,
          await digest(d.token),
        );
        for (const n of ["devices_get", "devices_delete", "devices_reissue"])
          await assert.rejects(
            operate(c, users[1].id, n, { device_id: d.id }),
            (e) => e.status === 404,
          );
        const next = await operate(c, users[0].id, "devices_reissue", {
          device_id: d.id,
        });
        assert.notEqual(next.token, d.token);
        await operate(c, users[0].id, "devices_delete", { device_id: d.id });
        throw rollback;
      }), error => error === rollback);
    } finally {
      await sql.end();
    }
  },
);
