import { generateKeyPair, exportSPKI, exportPKCS8 } from "jose";
import { readFile, writeFile, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const db = process.env.TEST_DATABASE_URL;
if (!db || !["localhost", "127.0.0.1"].includes(new URL(db).hostname))
  throw Error("Require an isolated local PostgreSQL test database");
const port = Number(process.env.TEST_PORT || 18787),
  base = "http://localhost:" + port;
const configs = [];
const keys = await generateKeyPair("RS256", { extractable: true });
const jwtKey = await exportSPKI(keys.publicKey);
const testPrivateKey = await exportPKCS8(keys.privateKey);
for (const worker of ["web", "api"]) {
  const root = "services/" + worker + "/",
    cfg = JSON.parse(await readFile(root + "wrangler.jsonc", "utf8"));
  delete cfg.routes;
  if (worker === "api")
    cfg.vars = {
      DATABASE_URL: db,
      ...cfg.vars,
      APP_ORIGIN: base,
      CLERK_SECRET_KEY: "sk_test_local_fixture",
      CLERK_JWT_KEY: jwtKey,
    };
  const file = root + "wrangler.e2e.json";
  await writeFile(file, JSON.stringify(cfg), { mode: 0o600 });
  configs.push(file);
}
const child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    ...configs.flatMap((c) => ["-c", c]),
    "--local",
    "--port",
    String(port),
    "--show-interactive-dev-session=false",
  ],
  { stdio: process.env.DEBUG_WORKERS ? "inherit" : "ignore", detached: true },
);
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error("Workers failed to start");
    try {
      if ((await fetch(base + "/backend/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(500);
  }
  if (!ready) throw Error("Workers timed out");
  for (const script of ["scripts/test-device.mjs", "scripts/test-browser.mjs"])
    execFileSync(process.execPath, [script], {
      stdio: "inherit",
      timeout: 120000,
      env: {
        ...process.env,
        TEST_SITE_URL: base,
        TEST_SIGNING_KEY: testPrivateKey,
      },
    });
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  for (const p of configs) await rm(p, { force: true });
}
