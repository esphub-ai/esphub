import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function migrate(tx) {
  await tx`SELECT pg_advisory_xact_lock(1764692911)`;
  await tx`CREATE TABLE IF NOT EXISTS public.esphub_migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz DEFAULT now())`;
  const files = (await readdir("migrations"))
    .filter((s) => s.endsWith(".sql") || s.endsWith(".mjs"))
    .sort();
  for (const file of files) {
    const contents = await readFile("migrations/" + file, "utf8"),
      hash = createHash("sha256").update(contents).digest("hex");
    const [old] =
      await tx`SELECT sha256 FROM public.esphub_migrations WHERE name=${file}`;
    if (old) {
      if (old.sha256 !== hash) throw Error("Changed migration: " + file);
      continue;
    }
    if (file.endsWith(".sql")) {
      await tx.unsafe(contents).simple();
    } else {
      const migration = await import(pathToFileURL(resolve("migrations", file)).href);
      await migration.default(tx);
    }
    await tx`INSERT INTO public.esphub_migrations(name,sha256) VALUES(${file},${hash})`;
    console.log("Applied", file);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.MIGRATION_DATABASE_URL) throw Error("Missing MIGRATION_DATABASE_URL");
  const sql = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql.begin(migrate);
  } finally {
    await sql.end();
  }
}
