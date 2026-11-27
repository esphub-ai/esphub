import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { identifyApiSubject, identifyApiUser } from "../services/api/src/auth.js";
import { boardPhotos } from "../services/api/src/board-photos.js";
import { operate } from "../services/api/src/operations.js";
import {
  archiveProject,
  createProject,
  createProjectRelease,
  createUserUploads,
  getOwnedProject,
  getPublicProject,
  listOwnedProjects,
  listPublicProjects,
  parseProjectAppUrl,
  projectAppResponse,
  projectImageObjectKey,
  projectReleaseObjectKey,
  removeProjectBoard,
  setCurrentProjectBoardRelease,
  updateProject,
} from "../services/api/src/projects.js";
import { stagingKey } from "../services/api/src/r2.js";
import { issuer } from "../shared/identity.js";
import { fixtureBucket } from "./fixtures/firmware.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const r2Env = {
  FIRMWARE_R2_ACCESS_KEY_ID: "test-r2-access-key",
  FIRMWARE_R2_SECRET_ACCESS_KEY: "test-r2-secret-key",
  FIRMWARE_R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  FIRMWARE_R2_BUCKET: "esphub-firmware",
};

function makeContext(env, authorization, sql) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("Authorization", authorization);
  return {
    env,
    req: {
      url: "https://api.esphub.ai/v1/projects",
      header: (name) => headers.get(name),
    },
    get: (key) => (key === "sql" ? sql : undefined),
  };
}

test("identifyApiSubject accepts Clerk personal API keys and Web session tokens, rejecting org/M2M/OAuth tokens", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const otherKeys = await generateKeyPair("RS256", { extractable: true });
  const jwtKey = await exportSPKI(publicKey);

  const verifyCalls = [];
  const clerkStub = http.createServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;
    const body = rawBody ? JSON.parse(rawBody) : {};
    verifyCalls.push({
      path: req.url,
      auth: req.headers.authorization,
      secret: body.secret,
    });
    res.setHeader("Content-Type", "application/json");
    if (body.secret === "ak_valid_personal") {
      res.end(
        JSON.stringify({
          id: "ak_1",
          type: "api_key",
          name: "CI Key",
          subject: "user_Personal123",
          scopes: [],
          claims: null,
          revoked: false,
          revocation_reason: null,
          expired: false,
          expiration: null,
          created_by: "user_Personal123",
          description: null,
          last_used_at: null,
          created_at: Date.now(),
          updated_at: Date.now(),
        }),
      );
      return;
    }
    if (body.secret === "ak_org_key") {
      res.end(
        JSON.stringify({
          id: "ak_2",
          type: "api_key",
          name: "Org Key",
          subject: "org_Team123",
          scopes: [],
          claims: null,
          revoked: false,
          revocation_reason: null,
          expired: false,
          expiration: null,
          created_by: "user_Personal123",
          description: null,
          last_used_at: null,
          created_at: Date.now(),
          updated_at: Date.now(),
        }),
      );
      return;
    }
    if (body.secret === "ak_revoked") {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          errors: [{ code: "api_key_revoked", message: "API key revoked" }],
        }),
      );
      return;
    }
    if (body.secret === "ak_server_error") {
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          errors: [{ code: "internal_error", message: "Clerk unavailable" }],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(
      JSON.stringify({
        errors: [{ code: "api_key_not_found", message: "Not found" }],
      }),
    );
  });
  await new Promise((resolve) => clerkStub.listen(0, "127.0.0.1", resolve));
  const clerkApiUrl = `http://127.0.0.1:${clerkStub.address().port}`;
  const env = {
    CLERK_SECRET_KEY: "sk_test_fixture",
    CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZXNwaHViLmFpJA",
    CLERK_JWT_KEY: jwtKey,
    CLERK_API_URL: clerkApiUrl,
  };

  try {
    // Valid personal API key
    const apiKeyAuth = await identifyApiSubject(
      makeContext(env, "Bearer ak_valid_personal"),
    );
    assert.deepEqual(apiKeyAuth, {
      subject: "user_Personal123",
      tokenType: "api_key",
    });
    assert.equal(verifyCalls.length, 1);
    assert.equal(verifyCalls[0].auth, "Bearer sk_test_fixture");

    // Valid Clerk session JWT
    const signSession = (claims = {}, { key = privateKey, exp = "5m" } = {}) =>
      new SignJWT({
        sub: "user_Personal123",
        sid: "sess_1",
        azp: "https://app.esphub.ai",
        ...claims,
      })
        .setProtectedHeader({
          alg: "RS256",
          kid: "test",
          typ: "JWT",
          cat: "cl_B7d4PD111AAA",
        })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(key);

    const sessionAuth = await identifyApiSubject(
      makeContext(env, "Bearer " + (await signSession())),
    );
    assert.deepEqual(sessionAuth, {
      subject: "user_Personal123",
      tokenType: "session_token",
    });

    // Org API key -> 403
    await assert.rejects(
      identifyApiSubject(makeContext(env, "Bearer ak_org_key")),
      (e) => e.status === 403,
    );

    // Clerk upstream 503 or missing secret key -> 503
    await assert.rejects(
      identifyApiSubject(makeContext(env, "Bearer ak_server_error")),
      (e) => e.status === 503,
    );
    await assert.rejects(
      identifyApiSubject(makeContext({ ...env, CLERK_SECRET_KEY: "" }, "Bearer ak_valid_personal")),
      (e) => e.status === 503,
    );

    // Invalid, revoked, missing, M2M, OAuth, expired, or wrong-key tokens -> 401
    const m2mJwt = await new SignJWT({ jti: "mt_1", sub: "mch_123", scopes: "mch_api" })
      .setProtectedHeader({ alg: "RS256", kid: "test", typ: "JWT", cat: "cl_B7d4PD333AAA" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const oauthJwt = await new SignJWT({ sub: "user_Personal123", aud: "https://api.esphub.ai/mcp" })
      .setProtectedHeader({ alg: "RS256", kid: "test", typ: "at+jwt" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await assert.rejects(identifyApiSubject(makeContext(env)), (e) => e.status === 401);
    for (const token of [
      "ak_unknown",
      "ak_revoked",
      "mt_opaque_token",
      "oat_opaque_token",
      m2mJwt,
      oauthJwt,
      await signSession({}, { exp: 1 }),
      await signSession({}, { key: otherKeys.privateKey }),
      await signSession({ azp: "https://evil.example" }),
      "not-a-token",
    ]) {
      await assert.rejects(
        identifyApiSubject(makeContext(env, "Bearer " + token)),
        (e) => e.status === 401,
        `Expected 401 for token ${token.slice(0, 20)}`,
      );
    }
  } finally {
    clerkStub.close();
  }
});

test("createUserUploads signs Content-Type and Content-Length into UUID staging URLs and enforces limits", async () => {
  const result = await createUserUploads(r2Env, {
    files: [
      { size: 842112, content_type: "application/octet-stream" },
      { size: 124560, content_type: "image/webp" },
      { size: 5242880, content_type: "image/png" },
      { size: 4096, content_type: "image/jpeg" },
    ],
  });
  assert.equal(result.uploads.length, 4);
  const expectedSpecs = [
    ["application/octet-stream", "842112"],
    ["image/webp", "124560"],
    ["image/png", "5242880"],
    ["image/jpeg", "4096"],
  ];
  const ids = new Set();
  for (let i = 0; i < result.uploads.length; i++) {
    const item = result.uploads[i];
    const [contentType, contentLength] = expectedSpecs[i];
    assert.match(item.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    ids.add(item.id);
    assert.equal(item.method, "PUT");
    assert.deepEqual(item.headers, {
      "Content-Type": contentType,
      "Content-Length": contentLength,
    });
    assert.ok(Date.parse(item.expires_at) > Date.now());
    const url = new URL(item.url);
    assert.equal(url.origin, "https://example.r2.cloudflarestorage.com");
    // UUID-only staging path with no owner prefix
    assert.equal(url.pathname, `/esphub-firmware/staging/uploads/${item.id}`);
    assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
    assert.equal(
      url.searchParams.get("X-Amz-SignedHeaders"),
      "content-length;content-type;host",
    );
    assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  }
  assert.equal(ids.size, 4);

  const badInputs = [
    null,
    {},
    { files: [] },
    { files: Array.from({ length: 21 }, () => ({ size: 10, content_type: "image/webp" })) },
    { files: [{ size: 10, content_type: "image/webp" }], extra: true },
    { files: [{ size: 0, content_type: "image/webp" }] },
    { files: [{ size: -1, content_type: "image/webp" }] },
    { files: [{ size: 1.5, content_type: "image/webp" }] },
    { files: [{ size: 5242881, content_type: "image/webp" }] },
    { files: [{ size: 33554433, content_type: "application/octet-stream" }] },
    { files: [{ size: 100, content_type: "image/svg+xml" }] },
    { files: [{ size: 100, content_type: "text/html" }] },
    { files: [{ size: 100, content_type: "image/webp", extra: 1 }] },
  ];
  for (const bad of badInputs) {
    await assert.rejects(createUserUploads(r2Env, bad), (e) => e.status === 400);
  }
  await assert.rejects(
    createUserUploads({}, { files: [{ size: 10, content_type: "image/webp" }] }),
    (e) => e.status === 503,
  );
});

test("CDN serves immutable project images from R2 with optional WebP resizing", async () => {
  const projectId = randomUUID();
  const webpBytes = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4);
  const pngBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8);
  const webpSha = sha256(webpBytes);
  const pngSha = sha256(pngBytes);
  const files = new Map([
    [projectImageObjectKey(projectId, webpSha, "webp"), webpBytes],
    [projectImageObjectKey(projectId, pngSha, "png"), pngBytes],
  ]);
  const transforms = [];
  const env = {
    FIRMWARE: fixtureBucket(files),
    IMAGES: {
      input(body) {
        return {
          transform(opts) {
            transforms.push(opts);
            return {
              output(outOpts) {
                return {
                  response: () =>
                    new Response(Uint8Array.of(9, 9, 9), {
                      status: 200,
                      headers: { "Content-Type": outOpts.format },
                    }),
                };
              },
            };
          },
        };
      },
    },
  };

  // Original PNG served directly with image/png and immutable cache header
  const pngRes = await boardPhotos.fetch(
    new Request(`https://cdn.esphub.ai/projects/${projectId}/images/${pngSha}.png`),
    env,
  );
  assert.equal(pngRes.status, 200);
  assert.equal(pngRes.headers.get("Content-Type"), "image/png");
  assert.equal(pngRes.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(pngRes.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(new Uint8Array(await pngRes.arrayBuffer()), pngBytes);

  // Resized WebP thumbnail with ?width=640
  const resizedRes = await boardPhotos.fetch(
    new Request(`https://cdn.esphub.ai/projects/${projectId}/images/${pngSha}.png?width=640`),
    env,
  );
  assert.equal(resizedRes.status, 200);
  assert.equal(resizedRes.headers.get("Content-Type"), "image/webp");
  assert.equal(resizedRes.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.deepEqual(transforms, [{ width: 640, height: 640, fit: "scale-down" }]);
  assert.deepEqual(new Uint8Array(await resizedRes.arrayBuffer()), Uint8Array.of(9, 9, 9));

  // Unsupported width -> 400
  const badWidth = await boardPhotos.fetch(
    new Request(`https://cdn.esphub.ai/projects/${projectId}/images/${webpSha}.webp?width=777`),
    env,
  );
  assert.equal(badWidth.status, 400);

  // Invalid UUID, extension, sha, or missing file -> 404
  for (const path of [
    `/projects/not-a-uuid/images/${webpSha}.webp`,
    `/projects/${projectId}/images/${webpSha}.svg`,
    `/projects/${projectId}/images/short.webp`,
    `/projects/${projectId}/images/${"0".repeat(64)}.webp`,
  ]) {
    const res = await boardPhotos.fetch(new Request(`https://cdn.esphub.ai${path}`), env);
    assert.equal(res.status, 404, path);
  }
});

test("parseProjectAppUrl parses latest and pinned project app URLs and rejects malformed ones", () => {
  const id = randomUUID();
  assert.equal(parseProjectAppUrl("https://example.com/app.bin"), null);
  assert.deepEqual(
    parseProjectAppUrl(`https://api.esphub.ai/projects/${id}/boards/m5stack/cardputer-adv/app`),
    { projectId: id, boardId: "m5stack/cardputer-adv", version: undefined },
  );
  assert.deepEqual(
    parseProjectAppUrl(
      `https://api.esphub.ai/projects/${id}/boards/m5stack/cardputer-adv/releases/1.2.3-rc.1/app`,
    ),
    { projectId: id, boardId: "m5stack/cardputer-adv", version: "1.2.3-rc.1" },
  );
  for (const bad of [
    `https://api.esphub.ai/projects/${id}/boards/m5stack/cardputer-adv/app?x=1`,
    `https://api.esphub.ai/projects/bad-id/boards/m5stack/cardputer-adv/app`,
    `https://api.esphub.ai/projects/${id}/boards/m5stack/cardputer-adv/releases/latest/app`,
    `https://api.esphub.ai/projects/${id}/unknown`,
  ]) {
    assert.throws(() => parseProjectAppUrl(bad), (e) => e.status === 400, bad);
  }
});

test(
  "projects lifecycle: draft creation, metadata & multi-image updates, per-board releases, MCP tools, public reads, rollback, unlink, archive, and runtime RBAC",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 });
    const realFetch = globalThis.fetch;
    try {
      const filesMap = new Map();
      const metadataMap = new Map();
      const contentTypeMap = new Map();
      let getCalls = 0;
      const baseBucket = fixtureBucket(filesMap, metadataMap);
      const bucket = {
        async head(key) {
          const obj = await baseBucket.head(key);
          if (!obj) return null;
          const ct = contentTypeMap.get(key);
          return ct ? { ...obj, httpMetadata: { contentType: ct } } : obj;
        },
        async get(key) {
          getCalls++;
          const obj = await baseBucket.get(key);
          if (!obj) return null;
          const ct = contentTypeMap.get(key);
          return ct ? { ...obj, httpMetadata: { contentType: ct } } : obj;
        },
        async delete(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            filesMap.delete(key);
            metadataMap.delete(key);
            contentTypeMap.delete(key);
          }
        },
      };

      const copies = [];
      globalThis.fetch = async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.origin === "https://example.r2.cloudflarestorage.com" && req.method === "PUT") {
          const copySource = req.headers.get("x-amz-copy-source");
          assert.ok(copySource);
          assert.equal(req.headers.get("x-amz-metadata-directive"), "REPLACE");
          assert.equal(req.headers.get("if-none-match"), "*");
          const srcKey = copySource.replace(/^\/esphub-firmware\//, "");
          const dstKey = url.pathname.replace(/^\/esphub-firmware\//, "");
          const data = filesMap.get(srcKey);
          if (!data) return new Response("NoSuchKey", { status: 404 });
          copies.push({
            srcKey,
            dstKey,
            contentType: req.headers.get("content-type"),
            sha256: req.headers.get("x-amz-meta-sha256"),
          });
          filesMap.set(dstKey, data);
          metadataMap.set(dstKey, { sha256: req.headers.get("x-amz-meta-sha256") });
          contentTypeMap.set(dstKey, req.headers.get("content-type"));
          return new Response("<CopyObjectResult/>", { status: 200 });
        }
        return realFetch(input, init);
      };

      const stage = (bytes, contentType) => {
        const uploadId = randomUUID();
        const key = stagingKey(uploadId);
        filesMap.set(key, bytes);
        contentTypeMap.set(key, contentType);
        return { upload_id: uploadId, size: bytes.length, sha256: sha256(bytes), content_type: contentType };
      };

      const env = { ...r2Env, FIRMWARE: bucket };
      const rollback = new Error("rollback");

      await assert.rejects(
        sql.begin(async (tx) => {
          const [alice, bob] = await tx`INSERT INTO esphub.accounts(clerk_subject)
            VALUES (${"user_projA" + randomUUID().replaceAll("-", "").slice(0, 12)}),
                   (${"user_projB" + randomUUID().replaceAll("-", "").slice(0, 12)})
            RETURNING id, clerk_subject`;

          const suffix = randomUUID().slice(0, 8);
          const boardA = `proj-vendor/board-a-${suffix}`;
          const boardB = `proj-vendor/board-b-${suffix}`;
          const retiredBoard = `proj-vendor/board-ret-${suffix}`;
          await tx`INSERT INTO esphub.boards
            (id, vendor, name, model, soc, flash_mb, flash_bus, psram, console, bootloader, retired)
            VALUES
              (${boardA}, 'proj-vendor', 'Board A', 'Proj Board A', 'esp32s3', 8, 'quad', null, 'usb-serial-jtag', 'esp32s3-8mb', false),
              (${boardB}, 'proj-vendor', 'Board B', 'Proj Board B', 'esp32s3', 16, 'octal', 'octal', 'usb-serial-jtag', 'esp32s3-16mb-opi', false),
              (${retiredBoard}, 'proj-vendor', 'Retired', 'Proj Retired', 'esp32s3', 8, 'quad', null, 'usb-serial-jtag', 'esp32s3-8mb', true)`;

          // 1. Create draft project via MCP projects_create (only name required)
          const draft = await operate({ env, sql: tx }, alice.id, "projects_create", {
            name: `Factory Demo ${suffix}`,
            description: "Initial draft description",
            repo_url: "https://github.com/esphub-ai/esphub-projects",
            repo_path: "projects/cardputer-factory-demo",
          });
          assert.match(draft.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
          assert.equal(draft.name, `Factory Demo ${suffix}`);
          assert.equal(draft.cover_image_url, null);
          assert.deepEqual(draft.images, []);
          assert.deepEqual(draft.boards, []);
          assert.equal(draft.archived, false);

          // Invalid repo_path without repo_url or path traversal rejected
          await assert.rejects(
            createProject(tx, alice.id, { name: "Bad", repo_path: "a/b" }),
            (e) => e.status === 400,
          );
          await assert.rejects(
            createProject(tx, alice.id, {
              name: "Bad",
              repo_url: "https://github.com/esphub-ai/repo",
              repo_path: "a/../b",
            }),
            (e) => e.status === 400,
          );

          // Draft is visible to Alice via /v1 and MCP, hidden from public directory and Bob
          const aliceList = await operate({ env, sql: tx }, alice.id, "projects_list", {});
          assert.equal(aliceList.some((p) => p.id === draft.id), true);
          const aliceGet = await operate({ env, sql: tx }, alice.id, "projects_get", {
            project_id: draft.id,
          });
          assert.equal(aliceGet.id, draft.id);
          assert.equal(
            (await listPublicProjects(tx, { query: suffix })).some((p) => p.id === draft.id),
            false,
          );
          await assert.rejects(getPublicProject(tx, draft.id), (e) => e.status === 404);
          await assert.rejects(
            operate({ env, sql: tx }, bob.id, "projects_get", { project_id: draft.id }),
            (e) => e.status === 404,
          );
          await assert.rejects(
            getOwnedProject(tx, bob.id, draft.id),
            (e) => e.status === 404,
          );

          // 2. Upload two preview images (WebP + PNG), set second as cover
          const img1 = stage(new Uint8Array(64).fill(11), "image/webp");
          const img2 = stage(new Uint8Array(80).fill(22), "image/png");
          const updatedWithImages = await updateProject(env, tx, alice.id, draft.id, {
            name: `Factory Demo ${suffix}`,
            description: "Updated with 2 screenshots",
            repo_url: "https://github.com/esphub-ai/esphub-projects",
            repo_path: "projects/cardputer-factory-demo",
            images: [
              { ...img1, is_cover: false },
              { ...img2, is_cover: true },
            ],
          });
          assert.equal(getCalls, 0, "PUT /v1/projects/:id must never read R2 object bodies");
          assert.equal(updatedWithImages.images.length, 2);
          assert.equal(updatedWithImages.images[0].is_cover, false);
          assert.equal(updatedWithImages.images[1].is_cover, true);
          assert.equal(
            updatedWithImages.cover_image_url,
            `https://cdn.esphub.ai/projects/${draft.id}/images/${img2.sha256}.png`,
          );
          // Staging keys cleaned up; immutable destination keys present with proper Content-Type
          assert.equal(filesMap.has(stagingKey(img1.upload_id)), false);
          assert.equal(filesMap.has(stagingKey(img2.upload_id)), false);
          assert.equal(
            contentTypeMap.get(projectImageObjectKey(draft.id, img1.sha256, "webp")),
            "image/webp",
          );
          assert.equal(
            contentTypeMap.get(projectImageObjectKey(draft.id, img2.sha256, "png")),
            "image/png",
          );

          // Reject >1 cover image
          await assert.rejects(
            updateProject(env, tx, alice.id, draft.id, {
              name: `Factory Demo ${suffix}`,
              images: [
                { sha256: img1.sha256, is_cover: true },
                { sha256: img2.sha256, is_cover: true },
              ],
            }),
            (e) => e.status === 400,
          );

          // Keep img1 only (reordered, no is_cover specified -> defaults index 0 to cover) and clean up removed img2 from R2
          const reordered = await updateProject(env, tx, alice.id, draft.id, {
            name: `Factory Demo ${suffix}`,
            description: "Single image now",
            repo_url: "https://github.com/esphub-ai/esphub-projects",
            repo_path: "projects/cardputer-factory-demo",
            images: [{ sha256: img1.sha256 }],
          });
          assert.equal(reordered.images.length, 1);
          assert.equal(reordered.images[0].is_cover, true);
          assert.equal(
            reordered.cover_image_url,
            `https://cdn.esphub.ai/projects/${draft.id}/images/${img1.sha256}.webp`,
          );
          assert.equal(filesMap.has(projectImageObjectKey(draft.id, img2.sha256, "png")), false);
          assert.equal(filesMap.has(projectImageObjectKey(draft.id, img1.sha256, "webp")), true);

          // Omitting images preserves existing images
          const metaOnly = await updateProject(env, tx, alice.id, draft.id, {
            name: `Factory Demo ${suffix}`,
            description: "Meta-only edit",
            repo_url: "https://github.com/esphub-ai/esphub-projects",
            repo_path: "projects/cardputer-factory-demo",
          });
          assert.equal(metaOnly.images.length, 1);

          // Bob cannot update Alice's project
          await assert.rejects(
            updateProject(env, tx, bob.id, draft.id, { name: "Hijack" }),
            (e) => e.status === 404,
          );

          // 3. Publish immutable releases for boardA and boardB
          const app1Bytes = new Uint8Array(256).fill(0xe9);
          const app1Stage = stage(app1Bytes, "application/octet-stream");
          const elfSha1 = sha256(Uint8Array.of(1, 2, 3));
          const rev1 = "a".repeat(40);
          const rel1Payload = {
            board_id: boardA,
            version: "1.0.0",
            sdk_version: "8.2.0",
            idf_version: "5.5.4",
            source_revision: rev1,
            promote: true,
            app: {
              upload_id: app1Stage.upload_id,
              size: app1Stage.size,
              sha256: app1Stage.sha256,
              elf_sha256: elfSha1,
            },
          };
          const rel1 = await createProjectRelease(env, tx, alice.id, draft.id, rel1Payload);
          assert.equal(rel1.status, 201);
          assert.equal(rel1.body.promoted, true);
          assert.equal(rel1.body.app.elf_sha256, elfSha1);
          assert.equal(getCalls, 0, "POST /v1/projects/:id/releases must never read R2 bodies");
          assert.equal(filesMap.has(stagingKey(app1Stage.upload_id)), false);
          assert.equal(
            filesMap.has(projectReleaseObjectKey(draft.id, boardA, "1.0.0")),
            true,
          );

          // Publish v1.1.0 for boardA (auto-promotes), then idempotently retry v1.0.0 -> must NOT roll back latest_version!
          const app2Stage = stage(new Uint8Array(320).fill(0xaa), "application/octet-stream");
          const rel2 = await createProjectRelease(env, tx, alice.id, draft.id, {
            board_id: boardA,
            version: "1.1.0",
            sdk_version: "8.2.0",
            app: {
              upload_id: app2Stage.upload_id,
              size: app2Stage.size,
              sha256: app2Stage.sha256,
            },
          });
          assert.equal(rel2.status, 201);

          const retryRel1 = await createProjectRelease(env, tx, alice.id, draft.id, rel1Payload);
          assert.equal(retryRel1.status, 200);
          assert.equal(retryRel1.body.promoted, false);

          // Conflicting release for same (project_id, board_id, version) -> 409
          await assert.rejects(
            createProjectRelease(env, tx, alice.id, draft.id, {
              ...rel1Payload,
              sdk_version: "9.0.0",
            }),
            (e) => e.status === 409,
          );

          // Publish commit-hash version with promote: false for boardA
          const app3Stage = stage(new Uint8Array(200).fill(0xbb), "application/octet-stream");
          const rel3 = await createProjectRelease(env, tx, alice.id, draft.id, {
            board_id: boardA,
            version: "abcdef12",
            sdk_version: "8.2.0",
            promote: false,
            app: {
              upload_id: app3Stage.upload_id,
              size: app3Stage.size,
              sha256: app3Stage.sha256,
            },
          });
          assert.equal(rel3.status, 201);
          assert.equal(rel3.body.promoted, false);

          // Publish for boardB as well
          const appBStage = stage(new Uint8Array(512).fill(0xcc), "application/octet-stream");
          const relB = await createProjectRelease(env, tx, alice.id, draft.id, {
            board_id: boardB,
            version: "1.0.0",
            sdk_version: "8.2.0",
            app: {
              upload_id: appBStage.upload_id,
              size: appBStage.size,
              sha256: appBStage.sha256,
            },
          });
          assert.equal(relB.status, 201);

          // Board validation errors: retired (400), unknown (404), oversize > flash_mb (400), wrong content_type (400)
          const badStage = stage(new Uint8Array(16).fill(1), "application/octet-stream");
          await assert.rejects(
            createProjectRelease(env, tx, alice.id, draft.id, {
              board_id: retiredBoard,
              version: "1.0.0",
              sdk_version: "8",
              app: { upload_id: badStage.upload_id, size: badStage.size, sha256: badStage.sha256 },
            }),
            (e) => e.status === 400,
          );
          await assert.rejects(
            createProjectRelease(env, tx, alice.id, draft.id, {
              board_id: "proj-vendor/no-such-board",
              version: "1.0.0",
              sdk_version: "8",
              app: { upload_id: badStage.upload_id, size: badStage.size, sha256: badStage.sha256 },
            }),
            (e) => e.status === 404,
          );
          await assert.rejects(
            createProjectRelease(env, tx, alice.id, draft.id, {
              board_id: boardA,
              version: "2.0.0",
              sdk_version: "8",
              app: {
                upload_id: badStage.upload_id,
                size: 8 * 1024 * 1024 + 1,
                sha256: badStage.sha256,
              },
            }),
            (e) => e.status === 400,
          );
          const wrongTypeStage = stage(new Uint8Array(16).fill(2), "image/webp");
          await assert.rejects(
            createProjectRelease(env, tx, alice.id, draft.id, {
              board_id: boardA,
              version: "2.0.1",
              sdk_version: "8",
              app: {
                upload_id: wrongTypeStage.upload_id,
                size: wrongTypeStage.size,
                sha256: wrongTypeStage.sha256,
              },
            }),
            (e) => e.status === 400,
          );

          // 4. Public reads & MCP search / get (including for Bob!)
          const byBoard = await operate({ env, sql: tx }, undefined, "projects_search", {
            board: boardA,
            query: suffix.toUpperCase(),
          });
          assert.equal(byBoard.length, 1);
          assert.equal(byBoard[0].id, draft.id);
          assert.deepEqual(
            byBoard[0].boards.map((b) => [b.board_id, b.version]),
            [
              [boardA, "1.1.0"],
              [boardB, "1.0.0"],
            ],
          );
          // SQL LIKE wildcard characters are treated literally
          assert.deepEqual(await listPublicProjects(tx, { query: "%" }), []);

          const bobView = await operate({ env, sql: tx }, bob.id, "projects_get", {
            project_id: draft.id,
          });
          assert.equal("archived" in bobView, false);
          assert.equal(bobView.boards.find((b) => b.board_id === boardA).version, "1.1.0");

          // Downloads: latest (must-revalidate) vs pinned (immutable)
          const latestRes = await projectAppResponse(tx, bucket, draft.id, boardA);
          assert.equal(latestRes.status, 200);
          assert.match(latestRes.headers.get("Cache-Control"), /must-revalidate/);
          assert.equal((await latestRes.arrayBuffer()).byteLength, 320);

          const pinnedRes = await projectAppResponse(tx, bucket, draft.id, boardA, "1.0.0");
          assert.equal(pinnedRes.status, 200);
          assert.match(pinnedRes.headers.get("Cache-Control"), /immutable/);
          assert.equal((await pinnedRes.arrayBuffer()).byteLength, 256);

          // 5. Roll back boardA to 1.0.0 via setCurrentProjectBoardRelease
          const rolled = await setCurrentProjectBoardRelease(tx, alice.id, draft.id, boardA, {
            version: "1.0.0",
          });
          assert.equal(rolled.version, "1.0.0");
          const afterRollback = await projectAppResponse(tx, bucket, draft.id, boardA);
          assert.equal((await afterRollback.arrayBuffer()).byteLength, 256);

          await assert.rejects(
            setCurrentProjectBoardRelease(tx, alice.id, draft.id, boardA, {
              version: "9.9.9",
            }),
            (e) => e.status === 404,
          );

          // 6. Unlink boardA: disappears from project_boards, latest download returns 404, pinned immutable download still works!
          const removed = await removeProjectBoard(tx, alice.id, draft.id, boardA);
          assert.equal(removed.removed, true);
          assert.deepEqual(
            (await listPublicProjects(tx, { board: boardA, query: suffix })),
            [],
          );
          await assert.rejects(
            projectAppResponse(tx, bucket, draft.id, boardA),
            (e) => e.status === 404,
          );
          const historicalRes = await projectAppResponse(tx, bucket, draft.id, boardA, "1.0.0");
          assert.equal(historicalRes.status, 200);

          // 7. Soft archive project: hidden from public + downloads + default list, visible with include_archived, blocks writes (409)
          const archived = await archiveProject(tx, alice.id, draft.id);
          assert.equal(archived.archived, true);
          assert.equal(
            (await listOwnedProjects(tx, alice.id)).some((p) => p.id === draft.id),
            false,
          );
          assert.equal(
            (await listOwnedProjects(tx, alice.id, { includeArchived: true })).some(
              (p) => p.id === draft.id,
            ),
            true,
          );
          await assert.rejects(getPublicProject(tx, draft.id), (e) => e.status === 404);
          await assert.rejects(
            projectAppResponse(tx, bucket, draft.id, boardB),
            (e) => e.status === 404,
          );
          await assert.rejects(
            projectAppResponse(tx, bucket, draft.id, boardA, "1.0.0"),
            (e) => e.status === 404,
          );
          await assert.rejects(
            updateProject(env, tx, alice.id, draft.id, { name: "Still archived" }),
            (e) => e.status === 409,
          );

          // Clear images test on a fresh project (images: [] explicitly allowed)
          const emptyProj = await createProject(tx, alice.id, { name: `Empty ${suffix}` });
          const cleared = await updateProject(env, tx, alice.id, emptyProj.id, {
            name: `Empty ${suffix}`,
            images: [],
          });
          assert.deepEqual(cleared.images, []);
          assert.equal(cleared.cover_image_url, null);

          // 8. Verify identifyApiUser maps Clerk subject to same account UUID as accountForSubject
          const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
          const jwtKey = await exportSPKI(publicKey);
          const sessJwt = await new SignJWT({
            sub: alice.clerk_subject,
            sid: "sess_alice",
            azp: "https://app.esphub.ai",
          })
            .setProtectedHeader({
          alg: "RS256",
          kid: "test",
          typ: "JWT",
          cat: "cl_B7d4PD111AAA",
        })
            .setIssuer(issuer)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
          const resolved = await identifyApiUser(
            makeContext(
              {
                CLERK_SECRET_KEY: "sk_test_fixture",
                CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZXNwaHViLmFpJA",
                CLERK_JWT_KEY: jwtKey,
              },
              "Bearer " + sessJwt,
              tx,
            ),
          );
          assert.equal(resolved.owner, alice.id);

          // 9. Verify ota_install auto-resolves project app_size and enforces board match + slot capacity
          const otaProject = await createProject(tx, alice.id, { name: `OTA Proj ${suffix}` });
          const bigStage = stage(new Uint8Array(600000).fill(0x55), "application/octet-stream");
          await createProjectRelease(env, tx, alice.id, otaProject.id, {
            board_id: boardA,
            version: "1.0.0",
            sdk_version: "8.2.0",
            app: { upload_id: bigStage.upload_id, size: bigStage.size, sha256: bigStage.sha256 },
          });
          const [devA] = await tx`INSERT INTO esphub.devices (owner, name, board, kind, token_hash, boot_id, boot_info)
            VALUES (
              ${alice.id}, 'Dev A', ${boardA}, 'physical', ${sha256(Uint8Array.of(9))},
              ${"a".repeat(32)},
              ${tx.json({ role: "bootloader", layout: { flash_size_bytes: 8388608, app_size_bytes: 524288, data_size_bytes: 1048576 } })}
            ) RETURNING id`;
          const enqueued = [];
          const otaCtx = {
            sql: tx,
            env: {
              ...env,
              DEVICE: {
                idFromName: (id) => id,
                get: () => ({
                  async fetch(url, init) {
                    if (String(url).includes("/enqueue")) {
                      const body = JSON.parse(init.body);
                      enqueued.push(body);
                      return Response.json({ command_id: randomUUID(), state: "queued" });
                    }
                    return Response.json({});
                  },
                }),
              },
            },
          };
          // 600000 > 524288 slot -> rejected with 409 resize hint even without image_size_bytes!
          await assert.rejects(
            operate(otaCtx, alice.id, "ota_install", {
              device_id: devA.id,
              kind: "app",
              url: `https://api.esphub.ai/projects/${otaProject.id}/boards/${boardA}/app`,
            }),
            (e) => e.status === 409 && /600000 bytes/.test(e.message),
          );
          // Wrong board URL -> 400
          await assert.rejects(
            operate(otaCtx, alice.id, "ota_install", {
              device_id: devA.id,
              kind: "app",
              url: `https://api.esphub.ai/projects/${otaProject.id}/boards/${boardB}/app`,
            }),
            (e) => e.status === 400,
          );
          // Fitting binary (256 bytes) -> queued with pinned immutable release URL and exact image_size!
          const smallStage = stage(new Uint8Array(256).fill(0x77), "application/octet-stream");
          await createProjectRelease(env, tx, alice.id, otaProject.id, {
            board_id: boardA,
            version: "1.0.1",
            sdk_version: "8.2.0",
            app: { upload_id: smallStage.upload_id, size: smallStage.size, sha256: smallStage.sha256 },
          });
          await operate(otaCtx, alice.id, "ota_install", {
            device_id: devA.id,
            kind: "app",
            url: `https://api.esphub.ai/projects/${otaProject.id}/boards/${boardA}/app`,
          });
          assert.equal(enqueued.length, 1);
          assert.equal(
            enqueued[0].args.url,
            `https://api.esphub.ai/projects/${otaProject.id}/boards/${boardA}/releases/1.0.1/app`,
          );
          assert.equal(enqueued[0].args.image_size, 256);

          // Omitting url for kind="app" is rejected (url is mandatory for app OTA)
          await assert.rejects(
            operate(otaCtx, alice.id, "ota_install", {
              device_id: devA.id,
              kind: "app",
            }),
            (e) => e.status === 400 && /url/.test(e.message),
          );

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
