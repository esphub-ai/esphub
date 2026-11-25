// One-time import from the last Git-backed gallery. After cutover, photos live in R2.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import postgres from "postgres";

const snapshot = "c783cc8fa6db0a8b83f7d8894a17cbb4d27d9dcf";
const assets = "services/web/src/assets";
const migration = "board-gallery-r2-v1";
const local = process.argv.includes("--local");
if (!local && !process.argv.includes("--remote"))
  throw Error("Specify --local or --remote");
const database = process.env.MIGRATION_DATABASE_URL;
if (
  !database ||
  (local && !["localhost", "127.0.0.1"].includes(new URL(database).hostname))
)
  throw Error("Expected a migration database for the selected environment");
const sql = postgres(database, { max: 1, prepare: false });
let platform;

async function store(key, bytes) {
  if (local) {
    platform ??= await (
      await import("wrangler")
    ).getPlatformProxy({
      configPath: "services/api/wrangler.jsonc",
      remoteBindings: false,
      persist: { path: ".wrangler/state/v3" },
    });
    await platform.env.FIRMWARE.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "image/webp" },
    });
    if (!(await platform.env.FIRMWARE.head(key)))
      throw Error("Missing local R2 photo: " + key);
    return;
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw Error("Missing Cloudflare R2 credentials");
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/esphub-firmware/objects/${key}`;
  const headers = { Authorization: "Bearer " + token };
  const existing = await fetch(url, { headers });
  await existing.body?.cancel();
  if (existing.ok) return; // A retry or a newer photo already owns this key.
  if (existing.status !== 404)
    throw Error(`R2 read failed for ${key}: ${existing.status}`);
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "image/webp", "If-None-Match": "*" },
    body: bytes,
  });
  if (put.status === 412) return;
  if (!put.ok) throw Error(`R2 upload failed for ${key}: ${put.status}`);
  const saved = await fetch(url, { headers });
  if (!saved.ok || !bytes.equals(Buffer.from(await saved.arrayBuffer())))
    throw Error("R2 verification failed for " + key);
}

try {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('esphub.board_gallery'))`;
    const [done] =
      await tx`SELECT 1 FROM public.esphub_migrations WHERE name = ${migration}`;
    if (done) return;
    try {
      execFileSync("git", ["cat-file", "-e", snapshot + "^{commit}"], {
        stdio: "ignore",
      });
    } catch {
      execFileSync("git", ["fetch", "--depth=1", "origin", snapshot]);
    }
    const file = (path) =>
      execFileSync("git", ["show", `${snapshot}:${assets}/${path}`]);
    const list = file("board-ids.json");
    const ids = JSON.parse(list);
    for (const id of ids) {
      await store(
        "boards/" + id + ".webp",
        file("boards/" + id.replace("/", "--") + ".webp"),
      );
    }
    await tx`UPDATE esphub.boards b SET display_order = gallery.ord
      FROM jsonb_array_elements_text(${tx.json(ids)}::jsonb) WITH ORDINALITY AS gallery(id, ord)
      WHERE b.id = gallery.id`;
    await tx`INSERT INTO public.esphub_migrations (name, sha256) VALUES
      (${migration}, ${createHash("sha256").update(list).digest("hex")})`;
    console.log(`Migrated ${ids.length} board photos and their gallery order.`);
  });
} finally {
  await platform?.dispose();
  await sql.end();
}
