import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Hono } from "hono";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { requireAdditionalScopes } from "@clerk/mcp-tools/hono";
import { issuer, mcpEndpoint } from "../shared/identity.js";
import {
  authenticateMcp,
  installMcpMetadata,
  serveMcp,
} from "../services/api/src/mcp.js";

test("authenticateMcp accepts Clerk OAuth tokens and personal API keys, rejecting org keys and other token types", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwtKey = await exportSPKI(publicKey);

  const clerkStub = http.createServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;
    const body = rawBody ? JSON.parse(rawBody) : {};
    res.setHeader("Content-Type", "application/json");

    if (req.url?.endsWith("/api_keys/verify")) {
      if (body.secret === "ak_valid_personal") {
        res.end(
          JSON.stringify({
            id: "ak_1",
            type: "api_key",
            name: "Personal MCP Key",
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
      return;
    }

    if (req.url?.endsWith("/oauth_applications/access_tokens/verify")) {
      const now = Date.now();
      const base = {
        object: "clerk_idp_oauth_access_token",
        id: "oat_id_1",
        client_id: "client_mcp_1",
        type: "oauth_token",
        subject: "user_Personal123",
        scopes: ["devices:read", "devices:write"],
        revoked: false,
        revocation_reason: null,
        expired: false,
        expiration: now + 3600_000,
        created_at: now,
        updated_at: now,
      };
      if (body.access_token === "oat_valid_rw") {
        res.end(JSON.stringify({ ...base, aud: mcpEndpoint }));
        return;
      }
      if (body.access_token === "oat_valid_ro") {
        res.end(
          JSON.stringify({
            ...base,
            scopes: ["devices:read"],
            aud: mcpEndpoint,
          }),
        );
        return;
      }
      if (body.access_token === "oat_missing_scope") {
        res.end(
          JSON.stringify({
            ...base,
            scopes: ["profile"],
            aud: mcpEndpoint,
          }),
        );
        return;
      }
      if (body.access_token === "oat_no_aud") {
        res.end(JSON.stringify(base));
        return;
      }
      if (body.access_token === "oat_wrong_aud") {
        res.end(JSON.stringify({ ...base, aud: "https://other.example/mcp" }));
        return;
      }
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          errors: [{ code: "resource_not_found", message: "Not found" }],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ code: "not_found", message: "Not found" }] }));
  });

  await new Promise((resolve) => clerkStub.listen(0, "127.0.0.1", resolve));
  const env = {
    CLERK_SECRET_KEY: "sk_test_fixture",
    CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZXNwaHViLmFpJA",
    CLERK_JWT_KEY: jwtKey,
    CLERK_API_URL: `http://127.0.0.1:${clerkStub.address().port}`,
  };

  const writeCheck = requireAdditionalScopes("devices:write");
  const app = new Hono();
  installMcpMetadata(app);
  app.post("/mcp", authenticateMcp, (c) => {
    const authInfo = c.get("mcpAuth");
    return c.json({
      userId: authInfo.extra.userId,
      clientId: authInfo.clientId,
      scopes: authInfo.scopes,
      writeChallenge: writeCheck({ authInfo }) ?? null,
    });
  });

  const mcpApp = new Hono();
  mcpApp.all("/mcp", authenticateMcp, serveMcp);

  const postAuth = (token, customEnv = env) =>
    app.fetch(
      new Request(mcpEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: "{}",
      }),
      customEnv,
    );

  try {
    // Protected resource metadata still serves cleanly without verifyToken leaking into options
    const prevPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
    process.env.CLERK_PUBLISHABLE_KEY = env.CLERK_PUBLISHABLE_KEY;
    try {
      const metaRes = await app.fetch(
        new Request(
          "https://api.esphub.ai/.well-known/oauth-protected-resource/mcp",
        ),
        env,
      );
      assert.equal(metaRes.status, 200);
      const meta = await metaRes.json();
      assert.equal(meta.resource, mcpEndpoint);
    } finally {
      if (prevPublishableKey === undefined)
        delete process.env.CLERK_PUBLISHABLE_KEY;
      else process.env.CLERK_PUBLISHABLE_KEY = prevPublishableKey;
    }

    // Valid personal API key -> 200 with read & write access
    const apiKeyRes = await postAuth("ak_valid_personal");
    assert.equal(apiKeyRes.status, 200);
    assert.deepEqual(await apiKeyRes.json(), {
      userId: "user_Personal123",
      clientId: "ak_1",
      scopes: ["devices:read", "devices:write"],
      writeChallenge: null,
    });

    // End-to-end MCP tools/list works with a personal API key
    const toolsRes = await mcpApp.fetch(
      new Request(mcpEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          Authorization: "Bearer ak_valid_personal",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
      env,
    );
    assert.equal(toolsRes.status, 200);
    const toolsText = await toolsRes.text();
    assert.match(toolsText, /"devices_send"/);

    // Valid opaque OAuth tokens -> 200, preserving Clerk scopes
    const oauthRwRes = await postAuth("oat_valid_rw");
    assert.equal(oauthRwRes.status, 200);
    assert.deepEqual(await oauthRwRes.json(), {
      userId: "user_Personal123",
      clientId: "client_mcp_1",
      scopes: ["devices:read", "devices:write"],
      writeChallenge: null,
    });

    const oauthRoRes = await postAuth("oat_valid_ro");
    assert.equal(oauthRoRes.status, 200);
    const oauthRoBody = await oauthRoRes.json();
    assert.equal(oauthRoBody.userId, "user_Personal123");
    assert.deepEqual(oauthRoBody.scopes, ["devices:read"]);
    assert.ok(oauthRoBody.writeChallenge);

    // OAuth token missing required devices:read scope -> 403
    const missingScopeRes = await postAuth("oat_missing_scope");
    assert.equal(missingScopeRes.status, 403);

    // Valid OAuth JWT with matching audience -> 200
    const signOAuthJwt = (claims = {}) =>
      new SignJWT({
        jti: "oat_jwt_1",
        sub: "user_Personal123",
        client_id: "client_mcp_jwt",
        scope: "devices:read devices:write",
        aud: mcpEndpoint,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test", typ: "at+jwt" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

    const oauthJwtRes = await postAuth(await signOAuthJwt());
    assert.equal(oauthJwtRes.status, 200);
    assert.deepEqual(await oauthJwtRes.json(), {
      userId: "user_Personal123",
      clientId: "client_mcp_jwt",
      scopes: ["devices:read", "devices:write"],
      writeChallenge: null,
    });

    // OAuth tokens missing or mismatched aud -> 401
    for (const token of [
      "oat_no_aud",
      "oat_wrong_aud",
      await signOAuthJwt({ aud: undefined }),
      await signOAuthJwt({ aud: "https://other.example/mcp" }),
    ]) {
      const res = await postAuth(token);
      assert.equal(res.status, 401, `Expected 401 for ${token.slice(0, 20)}`);
    }

    // Org API key, revoked/unknown API key, session JWT, M2M token, invalid/missing -> 401
    const sessionJwt = await new SignJWT({
      sub: "user_Personal123",
      sid: "sess_1",
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

    const m2mJwt = await new SignJWT({
      jti: "mt_1",
      sub: "mch_123",
      scopes: "mch_api",
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: "test",
        typ: "JWT",
        cat: "cl_B7d4PD333AAA",
      })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    for (const token of [
      undefined,
      "ak_org_key",
      "ak_revoked",
      "ak_unknown",
      "mt_opaque_token",
      sessionJwt,
      m2mJwt,
      "not-a-token",
    ]) {
      const res = await postAuth(token);
      assert.equal(
        res.status,
        401,
        `Expected 401 for ${String(token).slice(0, 20)}`,
      );
    }

    // Clerk upstream 503 and missing server credentials -> 5xx (not 401)
    const upstreamErrRes = await postAuth("ak_server_error");
    assert.equal(upstreamErrRes.status, 503);

    const missingSecretRes = await postAuth("ak_valid_personal", {
      ...env,
      CLERK_SECRET_KEY: "",
    });
    assert.equal(missingSecretRes.status, 500);
  } finally {
    clerkStub.close();
  }
});
