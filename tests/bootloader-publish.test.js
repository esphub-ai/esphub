import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { identifyMachine } from "../services/api/src/auth.js";
import {
  bootloaderObjectKey,
  createBootloaderVersion,
  createInternalUploads,
  setCurrentBootloaderRelease,
  stagingKey,
} from "../services/api/src/bootloader-publish.js";
import { bootloaderResponse, latestBootloader } from "../services/api/src/firmware.js";
import { fixtureBucket } from "./fixtures/firmware.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const r2Env = {
  FIRMWARE_R2_ACCESS_KEY_ID: "test-r2-access-key",
  FIRMWARE_R2_SECRET_ACCESS_KEY: "test-r2-secret-key",
  FIRMWARE_R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  FIRMWARE_R2_BUCKET: "esphub-firmware",
};

function makeContext(env, authorization) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("Authorization", authorization);
  return {
    env,
    req: {
      url: "https://api.esphub.ai/internal/uploads",
      header: (name) => headers.get(name),
    },
  };
}

test("identifyMachine accepts only authorized Clerk M2M JWTs with the required machine ID and scope", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const otherKeys = await generateKeyPair("RS256", { extractable: true });
  const jwtKey = await exportSPKI(publicKey);
  const env = {
    CLERK_SECRET_KEY: "sk_test_fixture",
    CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZXNwaHViLmFpJA",
    CLERK_JWT_KEY: jwtKey,
    CLERK_API_MACHINE_ID: "mch_api_target",
    CLERK_BOOTLOADER_MACHINE_ID: "mch_bootloader_caller",
  };
  const signM2M = (claims = {}, { key = privateKey, cat = "cl_B7d4PD333AAA", exp = "5m" } = {}) =>
    new SignJWT({
      jti: "mt_" + randomUUID().replaceAll("-", ""),
      sub: "mch_bootloader_caller",
      scopes: "mch_api_target",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test", typ: "JWT", ...(cat ? { cat } : {}) })
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key);

  const valid = await identifyMachine(makeContext(env, "Bearer " + (await signM2M())));
  assert.equal(valid.subject, "mch_bootloader_caller");
  assert.deepEqual(valid.scopes, ["mch_api_target"]);

  // Clerk M2M JWTs may carry target machine IDs in `aud` instead of `scopes`.
  const audToken = await signM2M({ scopes: undefined, aud: ["mch_api_target"] });
  const validAud = await identifyMachine(makeContext(env, "Bearer " + audToken));
  assert.equal(validAud.subject, "mch_bootloader_caller");

  // Missing header -> 401
  await assert.rejects(identifyMachine(makeContext(env)), (e) => e.status === 401);

  // Missing machine configuration -> 503
  await assert.rejects(
    identifyMachine(makeContext({ ...env, CLERK_BOOTLOADER_MACHINE_ID: "" }, "Bearer " + (await signM2M()))),
    (e) => e.status === 503,
  );

  // Wrong machine subject -> 403
  await assert.rejects(
    identifyMachine(makeContext(env, "Bearer " + (await signM2M({ sub: "mch_some_other" })))),
    (e) => e.status === 403,
  );

  // Missing target API machine scope -> 403
  await assert.rejects(
    identifyMachine(makeContext(env, "Bearer " + (await signM2M({ scopes: "mch_unrelated" })))),
    (e) => e.status === 403,
  );

  // Expired, wrong signature, session token, OAuth token -> 401
  const sessionJwt = await new SignJWT({ sub: "user_123", sid: "sess_1" })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ: "JWT", cat: "cl_B7d4PD111AAA" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const oauthJwt = await new SignJWT({ sub: "user_123", aud: "https://api.esphub.ai/mcp" })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ: "at+jwt" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  for (const token of [
    await signM2M({}, { exp: 1 }),
    await signM2M({}, { key: otherKeys.privateKey }),
    sessionJwt,
    oauthJwt,
    "not-a-token",
  ]) {
    await assert.rejects(identifyMachine(makeContext(env, "Bearer " + token)), (e) => e.status === 401);
  }
});

test("createInternalUploads signs presigned R2 staging PUT URLs and validates count", async () => {
  const result = await createInternalUploads(r2Env, { count: 3 });
  assert.equal(result.uploads.length, 3);
  const ids = new Set();
  for (const item of result.uploads) {
    assert.match(item.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    ids.add(item.id);
    assert.equal(item.method, "PUT");
    assert.deepEqual(item.headers, { "Content-Type": "application/octet-stream" });
    assert.ok(Date.parse(item.expires_at) > Date.now());
    const url = new URL(item.url);
    assert.equal(url.origin, "https://example.r2.cloudflarestorage.com");
    assert.equal(url.pathname, `/esphub-firmware/staging/uploads/${item.id}`);
    assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
    assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  }
  assert.equal(ids.size, 3);

  for (const bad of [{}, { count: 0 }, { count: 51 }, { count: 1.5 }, { count: "3" }, { count: 1, extra: true }]) {
    await assert.rejects(createInternalUploads(r2Env, bad), (e) => e.status === 400);
  }
  await assert.rejects(createInternalUploads({}, { count: 1 }), (e) => e.status === 503);
});

test(
  "createBootloaderVersion validates HEAD only, moves via R2 CopyObject, is idempotent, and promotes via bootloader_releases",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
    const realFetch = globalThis.fetch;
    try {
      const id = "esp32s3-" + randomUUID().slice(0, 6) + "mb";
      const filesMap = new Map();
      const metadataMap = new Map();
      let getCalls = 0;
      const baseBucket = fixtureBucket(filesMap, metadataMap);
      const bucket = {
        ...baseBucket,
        async get(key) {
          getCalls++;
          return baseBucket.get(key);
        },
      };
      const copies = [];
      globalThis.fetch = async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.origin === "https://example.r2.cloudflarestorage.com" && req.method === "PUT") {
          const copySource = req.headers.get("x-amz-copy-source");
          assert.ok(copySource, "Expected CopyObject x-amz-copy-source header");
          assert.equal(req.headers.get("x-amz-metadata-directive"), "REPLACE");
          assert.equal(req.headers.get("if-none-match"), "*");
          assert.ok(req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 "));
          const srcKey = copySource.replace(/^\/esphub-firmware\//, "");
          const dstKey = url.pathname.replace(/^\/esphub-firmware\//, "");
          const data = filesMap.get(srcKey);
          if (!data) return new Response("NoSuchKey", { status: 404 });
          copies.push({ srcKey, dstKey, sha256: req.headers.get("x-amz-meta-sha256") });
          filesMap.set(dstKey, data);
          metadataMap.set(dstKey, { sha256: req.headers.get("x-amz-meta-sha256") });
          return new Response("<CopyObjectResult/>", { status: 200 });
        }
        return realFetch(input, init);
      };

      const stageUpload = (bytes) => {
        const uploadId = randomUUID();
        filesMap.set(stagingKey(uploadId), bytes);
        return { upload_id: uploadId, size: bytes.length, sha256: sha256(bytes) };
      };
      const makePayload = (version, seed = 1) => {
        const bl = stageUpload(new Uint8Array(64).fill(seed));
        const pt = stageUpload(new Uint8Array(32).fill(seed + 1));
        const ln = stageUpload(new Uint8Array(128).fill(seed + 2));
        return {
          id,
          version,
          chip: "esp32s3",
          flash_mode: "dio",
          flash_size: "16MB",
          flash_freq: "80m",
          app_offset: 0x2a0000,
          nvs_offset: 0x9000,
          nvs_size: 0x6000,
          files: {
            bootloader: { ...bl, offset: 0 },
            partition_table: { ...pt, offset: 0x8000 },
            launcher: { ...ln, offset: 0x20000 },
          },
        };
      };

      const env = { ...r2Env, FIRMWARE: bucket };
      const rollback = new Error("rollback");
      await assert.rejects(
        sql.begin(async (tx) => {
          // 1. Create a commit-hash bootloader version
          const commitPayload = makePayload("a1b2c3d", 10);
          const created = await createBootloaderVersion(env, tx, commitPayload);
          assert.equal(created.status, 201);
          assert.equal(created.body.version, "a1b2c3d");
          assert.equal(getCalls, 0, "POST /internal/bootloaders must never read R2 object bodies");
          assert.equal(copies.length, 3);

          // Staging objects deleted after move; immutable destination objects present
          for (const entry of Object.values(commitPayload.files)) {
            assert.equal(filesMap.has(stagingKey(entry.upload_id)), false);
          }
          assert.equal(filesMap.has(bootloaderObjectKey(id, "a1b2c3d", "bootloader.bin")), true);
          assert.equal(filesMap.has(bootloaderObjectKey(id, "a1b2c3d", "partition-table.bin")), true);
          assert.equal(filesMap.has(bootloaderObjectKey(id, "a1b2c3d", "launcher.bin")), true);

          // Structured DB columns populated (no JSON column)
          const [stored] = await tx`SELECT * FROM esphub.bootloaders WHERE id = ${id} AND version = 'a1b2c3d'`;
          assert.equal(stored.bootloader_upload_id, commitPayload.files.bootloader.upload_id);
          assert.equal(stored.bootloader_size, 64);
          assert.equal(stored.partition_table_upload_id, commitPayload.files.partition_table.upload_id);
          assert.equal(stored.partition_table_size, 32);
          assert.equal(stored.launcher_upload_id, commitPayload.files.launcher.upload_id);
          assert.equal(stored.launcher_size, 128);

          // Not promoted yet -> latestBootloader is null
          assert.equal(await latestBootloader(tx, id), null);

          // Idempotent retry returns 200 even though staging objects are gone
          const retry = await createBootloaderVersion(env, tx, commitPayload);
          assert.equal(retry.status, 200);
          assert.deepEqual(retry.body, created.body);

          // Conflicting payload for the same (id, version) returns 409
          await assert.rejects(
            createBootloaderVersion(env, tx, { ...commitPayload, flash_freq: "40m" }),
            (e) => e.status === 409,
          );

          // Missing staging object -> 400
          const missingPayload = makePayload("2.1.0-rc.1", 20);
          filesMap.delete(stagingKey(missingPayload.files.launcher.upload_id));
          await assert.rejects(
            createBootloaderVersion(env, tx, missingPayload),
            (e) => e.status === 400,
          );

          // Size mismatch on HEAD -> 400
          const wrongSizePayload = makePayload("2.1.0-rc.2", 30);
          wrongSizePayload.files.bootloader.size = 999;
          await assert.rejects(
            createBootloaderVersion(env, tx, wrongSizePayload),
            (e) => e.status === 400,
          );

          // Duplicate upload_id -> 400
          const dupPayload = makePayload("2.1.0-rc.3", 40);
          dupPayload.files.launcher.upload_id = dupPayload.files.bootloader.upload_id;
          await assert.rejects(
            createBootloaderVersion(env, tx, dupPayload),
            (e) => e.status === 400,
          );

          // Invalid layout / chip mismatch -> 400
          const badLayout = makePayload("2.1.0-rc.4", 50);
          badLayout.app_offset = badLayout.files.launcher.offset;
          await assert.rejects(createBootloaderVersion(env, tx, badLayout), (e) => e.status === 400);
          await assert.rejects(
            createBootloaderVersion(env, tx, { ...makePayload("2.1.0-rc.5", 60), chip: "esp32c3" }),
            (e) => e.status === 400,
          );

          // Promote unknown version -> 404 (PostgreSQL FK violation; savepoint keeps test tx clean)
          await assert.rejects(
            tx.savepoint((sp) => setCurrentBootloaderRelease(sp, id, { version: "deadbeef" })),
            (e) => e.status === 404,
          );

          // Promote commit hash version -> 200
          const promoted = await setCurrentBootloaderRelease(tx, id, { version: "a1b2c3d" });
          assert.equal(promoted.id, id);
          assert.equal(promoted.version, "a1b2c3d");
          assert.ok(promoted.promoted_at);
          assert.equal((await latestBootloader(tx, id)).version, "a1b2c3d");

          // Download works via bootloaderResponse
          const dl = await bootloaderResponse(tx, bucket, id, "a1b2c3d", "launcher");
          assert.equal(dl.status, 200);
          assert.equal((await dl.arrayBuffer()).byteLength, 128);

          // Create semver version and switch current pointer to it, then roll back
          const semverPayload = makePayload("2.2.0", 70);
          assert.equal((await createBootloaderVersion(env, tx, semverPayload)).status, 201);
          assert.equal((await latestBootloader(tx, id)).version, "a1b2c3d");

          await setCurrentBootloaderRelease(tx, id, { version: "2.2.0" });
          assert.equal((await latestBootloader(tx, id)).version, "2.2.0");

          await setCurrentBootloaderRelease(tx, id, { version: "a1b2c3d" });
          assert.equal((await latestBootloader(tx, id)).version, "a1b2c3d");

          throw rollback;
        }),
        (err) => err === rollback,
      );
    } finally {
      globalThis.fetch = realFetch;
      await sql.end();
    }
  },
);
