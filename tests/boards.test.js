import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { boardGallery, getBoardDetail } from "../services/api/src/boards.js";
import { operate } from "../services/api/src/operations.js";
import { bootloaderSet } from "./fixtures/firmware.mjs";

test(
  "board discovery, detail lookup, and gallery reflect esphub.boards and published bootloaders",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
    try {
      await sql.begin(async (tx) => {
        const key = crypto.randomUUID();
        const id = "catalog-test/" + key;
        const loader = "catalog-test-" + key.slice(0, 8);
        await tx`INSERT INTO esphub.boards
          (id, vendor, name, model, soc, flash_mb, flash_bus, psram, console,
           bootloader, product_url, has_photo, preview)
          VALUES (${id}, 'catalog-test', 'Unlisted name', 'Test Model', 'esp32s3', 16, 'octal', 'octal',
            'usb-serial-jtag', ${loader}, 'https://example.com/board', true, true)`;

        const search = (query) =>
          operate({ sql: tx }, null, "boards_search", { query });
        const [preview] = await search(key.slice(0, 18).toUpperCase());
        assert.deepEqual(preview, {
          id,
          vendor: "catalog-test",
          name: "Unlisted name",
          model: "Test Model",
          bootloader: loader,
          spec: {
            soc: "esp32s3",
            flash_mb: 16,
            flash_bus: "octal",
            psram: "octal",
            console: "usb-serial-jtag",
          },
          product_url: "https://example.com/board",
          preview: true,
          image_url: `https://cdn.esphub.ai/boards/${id}/image`,
          firmware: {},
        });
        assert.equal("examples" in preview, false);
        assert.equal("default_example" in preview, false);
        assert.deepEqual(await search("Unlisted name"), []);
        assert.deepEqual(await search("%"), []);
        assert.deepEqual(await search("_"), []);

        // Gallery includes active photographed boards directly from esphub.boards.
        const galleryBefore = await boardGallery(tx);
        const entry = galleryBefore.find((b) => b.id === id);
        assert.ok(entry);
        assert.equal(entry.bootloader, loader);
        assert.deepEqual(entry.spec, preview.spec);
        assert.equal(entry.product_url, "https://example.com/board");
        assert.equal(entry.image_url, `https://cdn.esphub.ai/boards/${id}/image`);

        // Board without photo is omitted from gallery and gets image_url: null.
        await tx`UPDATE esphub.boards SET has_photo = false WHERE id = ${id}`;
        assert.equal((await boardGallery(tx)).some((b) => b.id === id), false);
        assert.equal((await search(id))[0].image_url, null);
        await tx`UPDATE esphub.boards SET has_photo = true WHERE id = ${id}`;

        // Boards share bootloader sets, and bootloader_releases selects the active version.
        for (const version of ["2.0.9", "2.0.10", "a1b2c3d"])
          await tx`INSERT INTO esphub.bootloaders ${tx({
            ...bootloaderSet(loader, version).row,
            chip: "esp32s3",
          })}`;
        const [unpromoted] = await search(id);
        assert.deepEqual(unpromoted.firmware, {});

        await tx`INSERT INTO esphub.bootloader_releases (id, version) VALUES (${loader}, '2.0.10')`;
        const [shared] = await search(id);
        assert.deepEqual(shared.firmware, {
          bootloader: {
            id: loader,
            version: "2.0.10",
            download_url: `https://api.esphub.ai/bootloaders/${loader}/2.0.10/launcher`,
          },
        });

        await tx`UPDATE esphub.bootloader_releases SET version = 'a1b2c3d', promoted_at = now() WHERE id = ${loader}`;
        const [commit] = await search(id);
        assert.deepEqual(commit.firmware, {
          bootloader: {
            id: loader,
            version: "a1b2c3d",
            download_url: `https://api.esphub.ai/bootloaders/${loader}/a1b2c3d/launcher`,
          },
        });

        // GET /boards/:vendor/:slug returns full board spec and active bootloader.
        const detail = await getBoardDetail(tx, id);
        assert.deepEqual(detail, {
          id,
          vendor: "catalog-test",
          name: "Unlisted name",
          model: "Test Model",
          bootloader: loader,
          spec: {
            soc: "esp32s3",
            flash_mb: 16,
            flash_bus: "octal",
            psram: "octal",
            console: "usb-serial-jtag",
          },
          product_url: "https://example.com/board",
          has_photo: true,
          preview: true,
          retired: false,
          image_url: `https://cdn.esphub.ai/boards/${id}/image`,
          firmware: {
            bootloader: {
              id: loader,
              version: "a1b2c3d",
              download_url: `https://api.esphub.ai/bootloaders/${loader}/a1b2c3d/launcher`,
            },
          },
        });

        // Retired boards disappear from search, gallery, and new registrations,
        // while staying readable by exact ID.
        await tx`UPDATE esphub.boards SET retired = true WHERE id = ${id}`;
        assert.deepEqual(await search(id), []);
        assert.equal((await boardGallery(tx)).some((b) => b.id === id), false);
        assert.equal((await getBoardDetail(tx, id)).retired, true);
        await assert.rejects(
          operate({ sql: tx }, null, "devices_create", {
            name: "Retired",
            board: id,
          }),
          (error) => error.status === 400,
        );

        // Unknown or malformed board IDs return 404.
        await assert.rejects(
          getBoardDetail(tx, "catalog-test/does-not-exist"),
          (error) => error.status === 404,
        );
        await assert.rejects(
          getBoardDetail(tx, "Bad/ID"),
          (error) => error.status === 404,
        );

        await tx`DELETE FROM esphub.bootloader_releases WHERE id = ${loader}`;
        await tx`DELETE FROM esphub.bootloaders WHERE id = ${loader}`;
        await tx`DELETE FROM esphub.boards WHERE id = ${id}`;
      });
    } finally {
      await sql.end();
    }
  },
);

test("boardGallery maps SQL rows into structured board gallery entries", async () => {
  const rows = [
    {
      id: "new-maker/new-board",
      name: "New Board",
      model: "New Maker New Board",
      soc: "esp32s3",
      flash_mb: 16,
      flash_bus: "quad",
      psram: "octal",
      console: "usb-serial-jtag",
      bootloader: "esp32s3-16mb",
      product_url: null,
    },
    {
      id: "new-maker/second-board",
      name: "Second Board",
      model: "New Maker Second Board",
      soc: "esp32s3",
      flash_mb: 32,
      flash_bus: "octal",
      psram: "octal",
      console: "usb-serial-jtag",
      bootloader: "esp32s3-32mb-opi",
      product_url: "https://example.com/board",
    },
  ];
  const gallery = await boardGallery(async () => rows);
  assert.deepEqual(gallery, [
    {
      id: "new-maker/new-board",
      name: "New Board",
      model: "New Maker New Board",
      bootloader: "esp32s3-16mb",
      spec: {
        soc: "esp32s3",
        flash_mb: 16,
        flash_bus: "quad",
        psram: "octal",
        console: "usb-serial-jtag",
      },
      product_url: null,
      image_url: "https://cdn.esphub.ai/boards/new-maker/new-board/image",
    },
    {
      id: "new-maker/second-board",
      name: "Second Board",
      model: "New Maker Second Board",
      bootloader: "esp32s3-32mb-opi",
      spec: {
        soc: "esp32s3",
        flash_mb: 32,
        flash_bus: "octal",
        psram: "octal",
        console: "usb-serial-jtag",
      },
      product_url: "https://example.com/board",
      image_url: "https://cdn.esphub.ai/boards/new-maker/second-board/image",
    },
  ]);
});
