import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { boardGallery } from "../services/api/src/boards.js";
import { operate } from "../services/api/src/operations.js";
import { bootloaderSet } from "./fixtures/firmware.mjs";

test(
  "board discovery reflects published versions and keeps previously returned downloads pinned",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
    try {
      await sql.begin(async (tx) => {
        const key = crypto.randomUUID();
        const id = "catalog-test/" + key;
        const published = [{ id: "hello", description: "Print hello", upstream: "https://example.com",
          source_url: "https://source.example/hello", entrypoint: "main.c" }];
        await tx`INSERT INTO esphub.boards
          (id, source_revision, name, model, chip, flash_mb, default_example, preview,
           published_examples, bootloader_source_url)
          SELECT ${id}, revision, 'Unlisted name', 'Test Model', 'esp32s3', 16, 'hello', true,
            ${tx.json(published)}, 'https://source.example/bootloader'
          FROM esphub.board_sources WHERE is_current`;
        const search = (query) =>
          operate({ sql: tx }, null, "boards_search", { query });
        const [preview] = await search(key.slice(0, 18).toUpperCase());
        assert.equal(preview.id, id);
        assert.deepEqual(preview.firmware, {});
        assert.deepEqual(preview.examples, published);
        assert.deepEqual(await search("Unlisted name"), []);
        assert.deepEqual(await search("%"), []);
        assert.deepEqual(await search("_"), []);

        await tx`INSERT INTO esphub.firmware_releases (board, kind, version, tag)
          VALUES (${id}, 'app', '1.0.9', 'test-app-1.0.9')`;
        const [before] = await search(id);
        assert.deepEqual(Object.keys(before.firmware), ["app"]);
        assert.equal(before.firmware.app.version, "1.0.9");
        const old = new URL(before.firmware.app.download_url);
        await tx`UPDATE esphub.firmware_releases SET version = '1.0.10', tag = 'test-app-1.0.10'
          WHERE board = ${id} AND kind = 'app'`;
        const [after] = await search(id);
        assert.equal(after.firmware.app.version, "1.0.10");
        assert.notEqual(after.firmware.app.download_url, old.href);
        assert.equal(old.pathname, "/releases/" + id + "/app");
        assert.equal(old.searchParams.get("tag"), "test-app-1.0.9");

        // Boards share bootloader sets, and the latest version by number is current.
        const loader = "catalog-test-" + key.slice(0, 8);
        await tx`UPDATE esphub.boards SET bootloader = ${loader} WHERE id = ${id}`;
        for (const version of ["2.0.9", "2.0.10"])
          await tx`INSERT INTO esphub.bootloaders ${tx({
            ...bootloaderSet(loader, version).row, chip: "esp32s3",
          })}`;
        const [shared] = await search(id);
        assert.deepEqual(shared.firmware.bootloader, {
          id: loader, version: "2.0.10",
          download_url: `https://api.esphub.ai/bootloaders/${loader}/2.0.10/launcher`,
        });

        await tx`DELETE FROM esphub.firmware_releases WHERE board = ${id}`;
        await tx`DELETE FROM esphub.bootloaders WHERE id = ${loader}`;
        await tx`DELETE FROM esphub.boards WHERE id = ${id}`;
        await assert.rejects(
          operate({ sql: tx }, null, "devices_create", {
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

test("the gallery includes current boards with an R2 photo across every listing page", async () => {
  const boards = [
    { id: "new-maker/new-board", product_url: null },
    { id: "new-maker/no-photo", product_url: null },
    { id: "new-maker/second-board", product_url: "https://example.com/board" },
  ];
  const bucket = {
    list({ prefix, cursor }) {
      assert.equal(prefix, "boards/");
      return cursor
        ? {
            objects: [{ key: "boards/new-maker/second-board.webp" }],
            truncated: false,
          }
        : {
            objects: [
              { key: "boards/new-maker/new-board.webp" },
              { key: "boards/new-maker/retired.webp" },
              { key: "boards/new-maker/no-photo.png" },
            ],
            truncated: true,
            cursor: "next",
          };
    },
  };
  const gallery = await boardGallery(async () => boards, bucket);
  assert.deepEqual(
    gallery.map((b) => b.id),
    [boards[0].id, boards[2].id],
  );
  assert.equal(
    gallery[0].image_url,
    "https://cdn.esphub.ai/boards/new-maker/new-board/image",
  );
  assert.equal(gallery[1].product_url, boards[2].product_url);
});
