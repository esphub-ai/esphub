import { generateKeyPair, exportSPKI, exportPKCS8 } from "jose";
import { readFile, writeFile, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startBroker } from "../tests/fixtures/iot/broker.mjs";
const db = process.env.TEST_DATABASE_URL;
if (!db || !["localhost", "127.0.0.1"].includes(new URL(db).hostname))
  throw Error("Require an isolated local PostgreSQL test database");
const port = Number(process.env.TEST_PORT || 18787),
  base = "http://localhost:" + port;
const configs = [];
const keys = await generateKeyPair("RS256", { extractable: true });
const jwtKey = await exportSPKI(keys.publicKey);
const testPrivateKey = await exportPKCS8(keys.privateKey);
const mqttPort = Number(process.env.TEST_MQTT_PORT || 18884);
const broker = await startBroker(base, mqttPort);
for (const worker of ["web", "api"]) {
  const root = "services/" + worker + "/",
    cfg = JSON.parse(await readFile(root + "wrangler.jsonc", "utf8"));
  delete cfg.routes;
  if (worker === "api") {
    // Intercept only the fixture's AWS hosts inside the local Worker. Production
    // uses the unmodified Worker entry and real TLS endpoints.
    const entry = root + "src/iot-e2e-entry.mjs";
    await writeFile(
      entry,
      `import worker from "./index.js";
      export {Device} from "./index.js";
      const realFetch=globalThis.fetch.bind(globalThis);
      let activeEnv;
      globalThis.fetch=async (input,init)=>{
        const req=new Request(input,init), url=new URL(req.url);
        if (["iot.us-west-2.amazonaws.com","fixture-ats.iot.us-west-2.amazonaws.com"].includes(url.hostname))
          return realFetch(new Request(${JSON.stringify(broker.endpoint)}+url.pathname+url.search, req));
        if (url.hostname==="fixture.r2.cloudflarestorage.com" && req.method==="PUT" && req.headers.get("x-amz-copy-source")) {
          const srcKey=req.headers.get("x-amz-copy-source").replace(/^\\/esphub-firmware\\//,"");
          const dstKey=url.pathname.replace(/^\\/esphub-firmware\\//,"");
          const src=await activeEnv.FIRMWARE.get(srcKey);
          if (!src) return new Response("NoSuchKey",{status:404});
          const sha=req.headers.get("x-amz-meta-sha256");
          await activeEnv.FIRMWARE.put(dstKey, await src.arrayBuffer(), {
            httpMetadata:{contentType:req.headers.get("content-type")||"application/octet-stream"},
            customMetadata: sha ? {sha256:sha} : {},
          });
          return new Response("<CopyObjectResult/>",{status:200});
        }
        return realFetch(input,init);
      };
      // Production routes cdn.esphub.ai to this Worker by hostname. Locally, /__cdn stands in for it.
      export default {...worker, async fetch(req, env, ctx) {
        activeEnv=env;
        const url=new URL(req.url);
        if (url.pathname.startsWith("/__r2/esphub-firmware/") && req.method==="PUT") {
          const key=url.pathname.slice("/__r2/esphub-firmware/".length);
          await env.FIRMWARE.put(key, await req.arrayBuffer());
          return new Response(null,{status:200});
        }
        if (url.pathname.startsWith("/__cdn/"))
          return worker.fetch(new Request("https://cdn.esphub.ai"+url.pathname.slice(6)+url.search, req), env, ctx);
        return worker.fetch(req, env, ctx);
      }};`,
    );
    configs.push(entry);
    cfg.main = "src/iot-e2e-entry.mjs";
    cfg.vars = {
      DATABASE_URL: db,
      ...cfg.vars,
      APP_ORIGIN: base,
      IOT_ACCOUNT_ID: "000000000000",
      IOT_ACCESS_KEY_ID: "fixture",
      IOT_SECRET_ACCESS_KEY: "fixture",
      IOT_DATA_ENDPOINT: "fixture-ats.iot.us-west-2.amazonaws.com",
      IOT_RELAY_SECRET: broker.secret,
      CLERK_SECRET_KEY: "sk_test_local_fixture",
      CLERK_JWT_KEY: jwtKey,
      CLERK_API_MACHINE_ID: "mch_local_api",
      CLERK_BOOTLOADER_MACHINE_ID: "mch_local_bootloader",
      FIRMWARE_R2_ACCESS_KEY_ID: "fixture",
      FIRMWARE_R2_SECRET_ACCESS_KEY: "fixture",
      FIRMWARE_R2_ENDPOINT: "https://fixture.r2.cloudflarestorage.com",
    };
  }
  const file = root + "wrangler.e2e.json";
  await writeFile(file, JSON.stringify(cfg), { mode: 0o600 });
  configs.push(file);
}
const child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    ...configs.filter((c) => c.endsWith(".json")).flatMap((c) => ["-c", c]),
    "--local",
    "--persist-to", ".wrangler/state",
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
    console.log(
      (
        await promisify(execFile)(process.execPath, [script], {
          timeout: 120000,
          env: {
            ...process.env,
            TEST_SITE_URL: base,
            TEST_MQTT_PORT: String(mqttPort),
            TEST_RELAY_SECRET: broker.secret,
            TEST_SIGNING_KEY: testPrivateKey,
          },
        })
      ).stdout,
    );
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  broker.close();
  for (const p of configs) await rm(p, { force: true });
}
