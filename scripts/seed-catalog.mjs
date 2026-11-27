// Seeds an empty local database and local R2 with the test board catalog and photos.
// Production receives both from the esphub-firmware publisher.
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { getPlatformProxy } from "wrangler";

const database = process.env.MIGRATION_DATABASE_URL;
if (!database || !["localhost", "127.0.0.1"].includes(new URL(database).hostname))
  throw Error("Expected a local migration database");
const fixture = (name) => readFile(new URL("../tests/fixtures/" + name, import.meta.url));
const { source, boards } = JSON.parse(await fixture("catalog.json"));
const photo = await fixture("board-photo.webp");
const sql = postgres(database, { max: 1, prepare: false, onnotice() {} });
const platform = await getPlatformProxy({
  configPath: "services/api/wrangler.jsonc",
  remoteBindings: false,
  persist: { path: ".wrangler/state/v3" },
});
try {
  for (const { id } of boards)
    await platform.env.FIRMWARE.put(`boards/${id}.webp`, photo, {
      httpMetadata: { contentType: "image/webp" },
    });
  await sql.begin(async (tx) => {
    const [existing] = await tx`SELECT 1 FROM esphub.board_sources LIMIT 1`;
    if (existing) return;
    await tx`INSERT INTO esphub.board_sources (revision, sdk_version, sdk_source_url, is_current)
      VALUES (${source.revision}, ${source.sdk_version}, ${source.sdk_source_url}, true)`;
    await tx`INSERT INTO esphub.boards (id, source_revision, name, model, chip, flash_mb,
        preview, display_order, default_example, published_examples, bootloader_source_url)
      SELECT id, ${source.revision}, name, model, chip, flash_mb,
        preview, display_order, default_example, published_examples, bootloader_source_url
      FROM jsonb_to_recordset(${tx.json(boards.map((board, i) => ({ ...board, display_order: i + 1 })))}::jsonb)
        AS b(id text, name text, model text, chip text, flash_mb int, preview boolean,
        display_order int, default_example text, published_examples jsonb, bootloader_source_url text)`;
    console.log(`Seeded ${boards.length} test boards`);
  });
} finally {
  await platform.dispose();
  await sql.end();
}
