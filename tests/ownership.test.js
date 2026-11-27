import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { bootloaderSet, fixtureBucket, recordFirmware } from "./fixtures/firmware.mjs";
import { operate } from "../services/api/src/operations.js";
import { reissueDeviceSetup } from "../services/api/src/setup.js";
import { parseNvs } from "../services/api/src/nvs.js";
import { digest } from "../services/api/src/auth.js";

test(
  "new registrations store only a token hash, stage NVS privately, and cannot cross account boundaries",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
    try {
      const rollback = new Error("Roll back ownership test data");
      await assert.rejects(sql.begin(async (tx) => {
        const users =
          await tx`INSERT INTO esphub.accounts(clerk_subject) SELECT 'user_' || md5(random()::text) FROM generate_series(1, 2) RETURNING id`;
        const boardId = "m5stack/cardputer-adv";
        const [board] = await tx`SELECT * FROM esphub.boards WHERE id = ${boardId}`;
        const set = bootloaderSet(board.bootloader);
        await recordFirmware(tx, set);
        const files = new Map(set.files);
        let lastStaged = null;
        const c = {
          sql: tx,
          env: {
            FIRMWARE: fixtureBucket(files),
            DEVICE: {
              idFromName: (id) => id,
              get: () => ({
                async fetch(url, init) {
                  if (String(url).includes("/stage-nvs")) {
                    lastStaged = new Uint8Array(await new Response(init.body).arrayBuffer());
                    const offset = Number(new URL(url).searchParams.get("offset"));
                    return Response.json({
                      url: "https://api.esphub.ai/setup/dev/nvs",
                      headers: { Authorization: "Bearer eh_nvs_" + "A".repeat(43) },
                      offset: "0x" + offset.toString(16),
                      size: lastStaged.byteLength,
                      sha256: createHash("sha256").update(lastStaged).digest("hex"),
                      expires_at: new Date(Date.now() + 900000).toISOString(),
                    });
                  }
                  return Response.json({});
                },
              }),
            },
          },
        };
        const args = { board: boardId, name: "Cardputer-Adv" },
          d = await operate(c, users[0].id, "devices_create", args);
        assert.equal("token" in d, false);
        assert.equal("ble_secret" in d, false);
        assert.deepEqual(
          d.flash.files.map(({ name }) => name),
          ["bootloader.bin", "partition-table.bin", "nvs.bin", "launcher.bin"],
        );
        const firstNvs = parseNvs(lastStaged);
        assert.equal(
          (await tx`SELECT token_hash FROM esphub.devices WHERE id=${d.id}`)[0]
            .token_hash,
          await digest(firstNvs.eh.tok),
        );
        for (const n of ["devices_get", "devices_delete"])
          await assert.rejects(
            operate(c, users[1].id, n, { device_id: d.id }),
            (e) => e.status === 404,
          );
        await assert.rejects(
          reissueDeviceSetup(c, users[1].id, d.id),
          (e) => e.status === 404,
        );
        const next = await reissueDeviceSetup(c, users[0].id, d.id);
        assert.equal("token" in next, false);
        assert.equal("ble_secret" in next, false);
        const nextNvs = parseNvs(lastStaged);
        assert.notEqual(nextNvs.eh.tok, firstNvs.eh.tok);
        assert.notEqual(nextNvs.eh.ble_key, firstNvs.eh.ble_key);
        await operate(c, users[0].id, "devices_delete", { device_id: d.id });
        throw rollback;
      }), (error) => error === rollback);
    } finally {
      await sql.end();
    }
  },
);
