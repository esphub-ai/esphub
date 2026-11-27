import postgres from "postgres";
import { writeFile } from "node:fs/promises";
const password = process.env.RUNTIME_DB_PASSWORD;
if (!password || !/^[a-f0-9]{64}$/.test(password))
  throw Error("Missing or invalid runtime database credential");
const uri = new URL(process.env.MIGRATION_DATABASE_URL);
const sql = postgres(uri.href, { max: 1, prepare: false });
try {
  await sql.begin(async (tx) => {
    const [r] =
      await tx`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='esphub_runtime') AS exists`;
    if (!r.exists)
      await tx.unsafe(
        "CREATE ROLE esphub_runtime LOGIN PASSWORD '" + password + "'",
      );
    await tx.unsafe("GRANT SELECT ON esphub.firmware_releases, esphub.release_assets, esphub.boards, esphub.board_examples, esphub.board_profiles TO esphub_runtime");
    await tx.unsafe("GRANT SELECT, INSERT ON esphub.bootloaders, esphub.project_releases TO esphub_runtime");
    await tx.unsafe("GRANT SELECT, INSERT, UPDATE ON esphub.bootloader_releases TO esphub_runtime");
    await tx.unsafe("GRANT USAGE ON SCHEMA esphub TO esphub_runtime");
    await tx.unsafe(
      "GRANT SELECT,INSERT,UPDATE,DELETE ON esphub.accounts, esphub.devices, esphub.virtual_boots, esphub.device_commands, esphub.iot_revocations, esphub.projects, esphub.project_images, esphub.project_boards TO esphub_runtime",
    );
    const [boardsPublisher] =
      await tx`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='esphub_boards_publisher') AS exists`;
    if (boardsPublisher.exists) {
      await tx.unsafe("GRANT USAGE ON SCHEMA esphub TO esphub_boards_publisher");
      await tx.unsafe("GRANT SELECT, INSERT, UPDATE ON esphub.boards TO esphub_boards_publisher");
    }
  });
} finally {
  await sql.end();
}
uri.username = "esphub_runtime";
uri.password = password;
const probe = postgres(uri.href, { max: 1, prepare: false });
try {
  await probe`SELECT id FROM esphub.devices LIMIT 0`;
} finally {
  await probe.end();
}
await writeFile(
  process.argv[2],
  JSON.stringify({
    DATABASE_URL: uri.href,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    ...(process.env.CLOUDFLARE_ACCOUNT_ID && {
      FIRMWARE_R2_ENDPOINT: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    }),
    ...Object.fromEntries(
      [
        "CLERK_MACHINE_SECRET_KEY",
        "FIRMWARE_R2_ACCESS_KEY_ID",
        "FIRMWARE_R2_SECRET_ACCESS_KEY",
        "FIRMWARE_R2_ENDPOINT",
        "IOT_RELAY_SECRET",
        "IOT_ACCOUNT_ID",
        "IOT_DATA_ENDPOINT",
        "IOT_ACCESS_KEY_ID",
        "IOT_SECRET_ACCESS_KEY",
      ]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    ),
  }),
  {
    mode: 0o600,
  },
);
