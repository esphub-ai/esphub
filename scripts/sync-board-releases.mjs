import postgres from "postgres";
import boards from "../shared/boards.generated.json" with { type: "json" };
import { publishedFirmware, assetNames } from "../shared/firmware-releases.js";

async function readManifest(board, kind, release) {
  const { chip, bootloader, flash_mb } = boards[board];
  const names = assetNames(board, chip, kind, release.version);
  const name = kind === "setup" ? names["setup-manifest"] : names.manifest;
  const response = await fetch(
    `https://github.com/okou-ai/esphub/releases/download/${release.tag}/${name}`,
  );
  if (!response.ok) throw Error(`Manifest ${name}: HTTP ${response.status}`);
  const m = await response.json();
  const size = kind === "setup" ? m.runtime_size : m.ota?.size;
  const hash = kind === "setup" ? m.sha256 : m.ota?.sha256;
  if (
    m.board !== board ||
    m.chip !== chip ||
    m.version !== release.version ||
    (kind === "bootloader" &&
      (m.bootloader !== bootloader || m.flash_mb !== flash_mb)) ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isSafeInteger(size) ||
    size <= 0
  )
    throw Error("Invalid manifest: " + name);
  return m;
}

const index = await publishedFirmware(boards, fetch, process.env.GH_TOKEN);
const rows = [];
for (const [board, releases] of Object.entries(index)) {
  if (boards[board].has_setup && !releases.setup)
    throw Error("Missing USB kit for " + board);
  if (boards[board].has_setup && !releases.bootloader)
    throw Error("Missing bootloader for " + board);
  for (const [kind, release] of Object.entries(releases)) {
    const manifest =
      kind === "micropython" ? null : await readManifest(board, kind, release);
    rows.push({
      board,
      kind,
      version: release.version,
      manifest: kind === "bootloader" ? manifest : null,
    });
  }
}

if (!process.env.MIGRATION_DATABASE_URL)
  throw Error("Missing MIGRATION_DATABASE_URL");
const sql = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
try {
  // A slower publish or deployment must not replace a newer catalog entry.
  await sql`INSERT INTO esphub.firmware_releases AS current (board, kind, version, manifest)
    SELECT board, kind, version, manifest FROM jsonb_to_recordset(${sql.json(rows)}::jsonb)
      AS incoming(board text, kind text, version text, manifest jsonb)
    ORDER BY board, kind
    ON CONFLICT (board, kind) DO UPDATE SET version = excluded.version, manifest = excluded.manifest
    WHERE string_to_array(excluded.version, '.')::numeric[] > string_to_array(current.version, '.')::numeric[]`;
  console.log(`Synchronized ${rows.length} firmware catalog entries`);
} finally {
  await sql.end();
}
