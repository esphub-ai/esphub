import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { migrate, rewrittenMigrations } from "../scripts/migrate.mjs";

test(
  "a rewritten migration replaces only the hash recorded before its rewrite",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1, onnotice() {} });
    try {
      const rollback = new Error("Roll back migration records");
      await assert.rejects(sql.begin(async (tx) => {
        for (const [name, original] of rewrittenMigrations) {
          const recorded = async () =>
            (await tx`SELECT sha256 FROM public.esphub_migrations WHERE name = ${name}`)[0].sha256;
          const current = await recorded();
          assert.notEqual(current, original);
          await tx`UPDATE public.esphub_migrations SET sha256 = ${original} WHERE name = ${name}`;
          await migrate(tx);
          assert.equal(await recorded(), current);
          await tx`UPDATE public.esphub_migrations SET sha256 = ${"0".repeat(64)} WHERE name = ${name}`;
          await assert.rejects(migrate(tx), new RegExp("Changed migration: " + name));
        }
        throw rollback;
      }), (error) => error === rollback);
    } finally {
      await sql.end();
    }
  },
);
