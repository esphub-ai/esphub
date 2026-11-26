// Seeds an empty local database with the test board catalog. Production receives its
// catalog from the esphub-firmware publisher.
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const database = process.env.MIGRATION_DATABASE_URL;
if (!database || !["localhost", "127.0.0.1"].includes(new URL(database).hostname))
  throw Error("Expected a local migration database");
const { source, boards } = JSON.parse(
  await readFile(new URL("../tests/fixtures/catalog.json", import.meta.url), "utf8"),
);
const sql = postgres(database, { max: 1, prepare: false, onnotice() {} });
try {
  await sql.begin(async (tx) => {
    const [existing] = await tx`SELECT 1 FROM esphub.board_sources LIMIT 1`;
    if (existing) return;
    await tx`INSERT INTO esphub.board_sources (revision, sdk_version, sdk_source_url, is_current)
      VALUES (${source.revision}, ${source.sdk_version}, ${source.sdk_source_url}, true)`;
    await tx`INSERT INTO esphub.boards (id, source_revision, name, model, chip, flash_mb, bootloader,
        preview, default_example, examples, published_examples, bootloader_source_url)
      SELECT id, ${source.revision}, name, model, chip, flash_mb, bootloader,
        preview, default_example, examples, published_examples, bootloader_source_url
      FROM jsonb_to_recordset(${tx.json(boards)}::jsonb) AS b(id text, name text, model text, chip text,
        flash_mb int, bootloader text, preview boolean, default_example text, examples jsonb,
        published_examples jsonb, bootloader_source_url text)`;
    console.log(`Seeded ${boards.length} test boards`);
  });
} finally {
  await sql.end();
}
