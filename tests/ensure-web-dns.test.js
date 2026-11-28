import test from "node:test";
import assert from "node:assert/strict";
import {
  WEB_HOSTNAMES,
  WORKER_NAME,
  ZONE_NAME,
  applyWebDns,
  preflightWebDns,
} from "../scripts/ensure-web-dns.mjs";

function jsonResponse(result, { status = 200, success = true, errors = [] } = {}) {
  return new Response(JSON.stringify({ success, result, errors }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("preflight skips TXT probe when proxied placeholder DNS already exists and no custom domains remain", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname === "/client/v4/zones") {
      return jsonResponse([{ id: "zone_1", name: ZONE_NAME }]);
    }
    if (u.pathname === "/client/v4/zones/zone_1/workers/routes") {
      return jsonResponse([]);
    }
    if (u.pathname === "/client/v4/accounts/acc_1/workers/domains") {
      return jsonResponse([]);
    }
    if (u.pathname === "/client/v4/zones/zone_1/dns_records" && method === "GET") {
      const name = u.searchParams.get("name");
      return jsonResponse([
        { id: `rec_${name}`, type: "AAAA", name, content: "100::", proxied: true, meta: {} },
      ]);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await preflightWebDns({
    apiToken: "tok",
    accountId: "acc_1",
    fetchImpl,
    log: () => {},
  });
  assert.equal(result.needsMigration, false);
  assert.ok(!calls.some((c) => c.startsWith("POST ")));
});

test("preflight runs non-destructive TXT probe when custom domains still exist and fails fast on 403", async () => {
  let deletedProbe = false;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.pathname === "/client/v4/zones") {
      return jsonResponse([{ id: "zone_1", name: ZONE_NAME }]);
    }
    if (u.pathname === "/client/v4/zones/zone_1/workers/routes") {
      return jsonResponse([]);
    }
    if (u.pathname === "/client/v4/accounts/acc_1/workers/domains") {
      return jsonResponse([
        { id: "dom_app", hostname: "app.esphub.ai", service: WORKER_NAME },
      ]);
    }
    if (u.pathname === "/client/v4/zones/zone_1/dns_records" && method === "GET") {
      const name = u.searchParams.get("name");
      return jsonResponse([
        {
          id: `worker_${name}`,
          type: "AAAA",
          name,
          content: "100::",
          proxied: true,
          meta: { origin_worker_id: "esphub-web" },
        },
      ]);
    }
    if (u.pathname === "/client/v4/zones/zone_1/dns_records" && method === "POST") {
      return jsonResponse({ id: "txt_probe_1" });
    }
    if (u.pathname === "/client/v4/zones/zone_1/dns_records/txt_probe_1" && method === "DELETE") {
      deletedProbe = true;
      return jsonResponse({ id: "txt_probe_1" });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const ok = await preflightWebDns({
    apiToken: "tok",
    accountId: "acc_1",
    fetchImpl,
    log: () => {},
  });
  assert.equal(ok.needsMigration, true);
  assert.equal(deletedProbe, true);

  await assert.rejects(
    preflightWebDns({
      apiToken: "tok",
      accountId: "acc_1",
      log: () => {},
      fetchImpl: async (url, init = {}) => {
        if ((init.method ?? "GET") === "POST") {
          return jsonResponse(null, {
            status: 403,
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          });
        }
        return fetchImpl(url, init);
      },
    }),
    /Zone:DNS:Edit is required/,
  );
});

test("apply detaches custom domains one by one, retries transient 81053 conflict, and creates proxied AAAA 100:: records", async () => {
  const events = [];
  const postAttempts = new Map();

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.pathname === "/client/v4/zones") {
      return jsonResponse([{ id: "zone_1", name: ZONE_NAME }]);
    }
    if (u.pathname === "/client/v4/zones/zone_1/workers/routes") {
      return jsonResponse(
        WEB_HOSTNAMES.map((h) => ({ id: `rt_${h}`, pattern: `${h}/*`, script: WORKER_NAME })),
      );
    }
    if (u.pathname === "/client/v4/accounts/acc_1/workers/domains" && method === "GET") {
      return jsonResponse(
        WEB_HOSTNAMES.map((h) => ({ id: `dom_${h}`, hostname: h, service: WORKER_NAME })),
      );
    }
    if (u.pathname.startsWith("/client/v4/accounts/acc_1/workers/domains/") && method === "DELETE") {
      events.push(`delete:${u.pathname.split("/").pop()}`);
      return jsonResponse({});
    }
    if (u.pathname === "/client/v4/zones/zone_1/dns_records" && method === "GET") {
      return jsonResponse([]);
    }
    if (u.pathname === "/client/v4/zones/zone_1/dns_records" && method === "POST") {
      const body = JSON.parse(init.body);
      const n = (postAttempts.get(body.name) ?? 0) + 1;
      postAttempts.set(body.name, n);
      if (body.name === "app.esphub.ai" && n === 1) {
        return jsonResponse(null, {
          status: 400,
          success: false,
          errors: [{ code: 81053, message: "An A, AAAA, or CNAME record with that host already exists." }],
        });
      }
      assert.equal(body.type, "AAAA");
      assert.equal(body.content, "100::");
      assert.equal(body.proxied, true);
      events.push(`create:${body.name}`);
      return jsonResponse({ id: `rec_${body.name}` });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await applyWebDns({
    apiToken: "tok",
    accountId: "acc_1",
    fetchImpl,
    sleep: async () => {},
    retryDelaysMs: [1, 1],
    log: () => {},
  });

  assert.deepEqual(result.detached, WEB_HOSTNAMES);
  assert.deepEqual(result.created, WEB_HOSTNAMES);
  assert.deepEqual(events, [
    "delete:dom_esphub.ai",
    "create:esphub.ai",
    "delete:dom_www.esphub.ai",
    "create:www.esphub.ai",
    "delete:dom_app.esphub.ai",
    "create:app.esphub.ai",
  ]);
});

test("apply refuses to detach custom domains when replacement Zone Routes are missing", async () => {
  let detached = false;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.pathname === "/client/v4/zones") {
      return jsonResponse([{ id: "zone_1", name: ZONE_NAME }]);
    }
    if (u.pathname === "/client/v4/zones/zone_1/workers/routes") {
      return jsonResponse([]);
    }
    if (method === "DELETE") detached = true;
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  await assert.rejects(
    applyWebDns({ apiToken: "tok", accountId: "acc_1", fetchImpl, log: () => {} }),
    /Expected Workers Route/,
  );
  assert.equal(detached, false);
});
