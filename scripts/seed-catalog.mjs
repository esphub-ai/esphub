// Seeds an empty local database and local R2 with the test board catalog, photos,
// and bootloader sets. Production receives board specs and photos from esphub-boards
// and bootloader sets from esphub-bootloader.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { getPlatformProxy } from "wrangler";
import { bootloaderSet, recordFirmware } from "../tests/fixtures/firmware.mjs";

const database = process.env.MIGRATION_DATABASE_URL;
if (!database || !["localhost", "127.0.0.1"].includes(new URL(database).hostname))
  throw Error("Expected a local migration database");
const fixture = (name) => readFile(new URL("../tests/fixtures/" + name, import.meta.url));
const { boards } = JSON.parse(await fixture("catalog.json"));
const photo = await fixture("board-photo.webp");
const sql = postgres(database, { max: 1, prepare: false, onnotice() {} });
const platform = await getPlatformProxy({
  configPath: "services/api/wrangler.jsonc",
  remoteBindings: false,
  persist: { path: ".wrangler/state/v3" },
});
try {
  for (const { id, has_photo } of boards) {
    if (!has_photo) continue;
    await platform.env.FIRMWARE.put(`boards/${id}.webp`, photo, {
      httpMetadata: { contentType: "image/webp" },
    });
  }
  const sets = [...new Set(boards.map((board) => board.bootloader))].map((id) => bootloaderSet(id));
  for (const { files } of sets)
    for (const [key, body] of files)
      await platform.env.FIRMWARE.put(key, body, {
        customMetadata: { sha256: createHash("sha256").update(body).digest("hex") },
      });
  await sql.begin(async (tx) => {
    const [existing] = await tx`SELECT 1 FROM esphub.boards LIMIT 1`;
    if (existing) return;
    const rows = boards.map((board, i) => ({
      ...board,
      vendor: board.id.split("/")[0],
      display_order: i + 1,
    }));
    await tx`INSERT INTO esphub.boards
        (id, vendor, name, model, soc, flash_mb, flash_bus, psram, console,
         bootloader, product_url, has_photo, preview, retired, display_order)
      SELECT id, vendor, name, model, soc, flash_mb, flash_bus, psram, console,
        bootloader, product_url, has_photo, preview, false, display_order
      FROM jsonb_to_recordset(${tx.json(rows)}::jsonb)
        AS b(id text, vendor text, name text, model text, soc text, flash_mb int,
        flash_bus text, psram text, console text, bootloader text, product_url text,
        has_photo boolean, preview boolean, display_order int)`;
    for (const firmware of sets) await recordFirmware(tx, firmware);
    console.log(`Seeded ${boards.length} test boards and ${sets.length} bootloader sets`);
  });
} finally {
  await platform.dispose();
  await sql.end();
}
