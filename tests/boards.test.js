import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { operate } from "../services/api/src/operations.js";

test(
  "board discovery reflects published versions and keeps previously returned downloads pinned",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
    try {
      await sql.begin(async (tx) => {
        const key = crypto.randomUUID();
        const id = "catalog-test/" + key;
        await tx`INSERT INTO esphub.boards
          (id, source_revision, name, model, chip, flash_mb, bootloader, default_example, examples, preview)
          SELECT ${id}, revision, 'Unlisted name', 'Test Model', 'esp32s3', 16, 'esp32s3-16mb', 'hello', '[{"id":"hello","description":"Print hello","entrypoint":"examples/hello/main.c","upstream":"https://example.com"}]'::jsonb, true
          FROM esphub.board_sources WHERE is_current`;
        const search = (query) =>
          operate({ sql: tx }, null, "boards.search", { query });
        const [preview] = await search(key.slice(0, 18).toUpperCase());
        assert.equal(preview.id, id);
        assert.deepEqual(preview.firmware, {});
        assert.deepEqual(await search("Unlisted name"), []);
        assert.deepEqual(await search("%"), []);
        assert.deepEqual(await search("_"), []);

        await tx`INSERT INTO esphub.firmware_releases (board, kind, version)
          VALUES (${id}, 'app', '1.0.9'), (${id}, 'setup', '2.0.1')`;
        const [before] = await search(id);
        assert.equal(before.firmware.setup.version, "2.0.1");
        assert.equal(before.firmware.app.version, "1.0.9");
        const old = new URL(before.firmware.app.download_url);
        await tx`UPDATE esphub.firmware_releases SET version = '1.0.10' WHERE board = ${id} AND kind = 'app'`;
        const [after] = await search(id);
        assert.equal(after.firmware.app.version, "1.0.10");
        assert.notEqual(after.firmware.app.download_url, old.href);
        assert.equal(
          after.firmware.setup.download_url,
          before.firmware.setup.download_url,
        );
        assert.equal(old.pathname, "/releases/" + id + "/app");
        assert.ok(old.searchParams.get("tag").endsWith("-v1.0.9"));

        await tx`DELETE FROM esphub.firmware_releases WHERE board = ${id}`;
        await tx`DELETE FROM esphub.boards WHERE id = ${id}`;
        await assert.rejects(
          operate({ sql: tx }, null, "devices.create", {
            name: "Unknown",
            board: id,
          }),
          (error) => error.status === 400,
        );
      });
    } finally {
      await sql.end();
    }
  },
);
