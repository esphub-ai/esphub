import { pathToFileURL } from "node:url";
import { browserOrigins } from "../shared/identity.js";

export const ZONE_NAME = "esphub.ai";
export const WORKER_NAME = "esphub-web";
export const WEB_HOSTNAMES = browserOrigins.map((origin) => new URL(origin).hostname);
const PLACEHOLDER_CONTENT = "100::";
const PLACEHOLDER_COMMENT = "Placeholder origin for esphub-web Workers route";
const PREFLIGHT_RECORD_NAME = `_esphub-dns-preflight.${ZONE_NAME}`;
const ROUTING_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);
const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 2000, 3000, 3000];

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isWorkerOwnedDnsRecord(record) {
  return Boolean(record?.meta?.origin_worker_id);
}

export function findManagedRoutingRecords(records, hostname) {
  const target = hostname.toLowerCase();
  return (records ?? []).filter(
    (record) =>
      typeof record?.name === "string" &&
      record.name.toLowerCase() === target &&
      ROUTING_RECORD_TYPES.has(record.type) &&
      !isWorkerOwnedDnsRecord(record),
  );
}

export function createCloudflareClient({
  apiToken,
  baseUrl = "https://api.cloudflare.com/client/v4",
  fetchImpl = globalThis.fetch,
}) {
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required");

  return async function cf(path, { method = "GET", body } = {}) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `Cloudflare API ${method} ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok || payload.success === false) {
      const codes = (payload.errors ?? []).map((e) => e.code).filter(Boolean);
      const detail =
        (payload.errors ?? [])
          .map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown"}`)
          .join("; ") || text.slice(0, 200);
      const err = new Error(
        `Cloudflare API ${method} ${path} failed (${res.status}): ${detail}`,
      );
      err.status = res.status;
      err.codes = codes;
      throw err;
    }
    return payload.result;
  };
}

async function resolveZoneId(cf, accountId, zoneName = ZONE_NAME) {
  const params = new URLSearchParams({ name: zoneName });
  if (accountId) params.set("account.id", accountId);
  const zones = await cf(`/zones?${params.toString()}`);
  const zone = (zones ?? []).find((z) => z.name === zoneName);
  if (!zone?.id) {
    throw new Error(`Cloudflare zone "${zoneName}" not found for account ${accountId}`);
  }
  return zone.id;
}

async function listWorkerCustomDomains(cf, accountId, workerName = WORKER_NAME) {
  const params = new URLSearchParams({ service: workerName });
  const domains = await cf(`/accounts/${accountId}/workers/domains?${params.toString()}`);
  return (domains ?? []).filter(
    (d) => d.service === workerName && WEB_HOSTNAMES.includes(d.hostname),
  );
}

async function listHostDnsRecords(cf, zoneId, hostname) {
  const params = new URLSearchParams({ name: hostname, per_page: "100" });
  return (await cf(`/zones/${zoneId}/dns_records?${params.toString()}`)) ?? [];
}

function isRetryableDnsConflict(error) {
  const codes = new Set(error?.codes ?? []);
  return codes.has(81053) || codes.has(81057) || codes.has(81058) || error?.status === 409;
}

export async function preflightWebDns({
  apiToken,
  accountId,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  const cf = createCloudflareClient({ apiToken, fetchImpl });
  const zoneId = await resolveZoneId(cf, accountId);

  // Confirm token can read Workers Routes on the zone.
  await cf(`/zones/${zoneId}/workers/routes`);

  const customDomains = await listWorkerCustomDomains(cf, accountId);
  const missingHosts = [];

  for (const host of WEB_HOSTNAMES) {
    const records = await listHostDnsRecords(cf, zoneId, host);
    const managed = findManagedRoutingRecords(records, host);
    const proxied = managed.find((r) => r.proxied === true);
    if (managed.length > 0 && !proxied) {
      throw new Error(
        `Host "${host}" has existing unproxied DNS record(s); refusing to deploy Workers route over grey-cloud DNS.`,
      );
    }
    if (!proxied) missingHosts.push(host);
  }

  if (customDomains.length === 0 && missingHosts.length === 0) {
    log(
      `Preflight OK: proxied DNS records already exist for ${WEB_HOSTNAMES.join(", ")} and no Custom Domains remain on ${WORKER_NAME}.`,
    );
    return { zoneId, needsMigration: false, missingHosts: [], customDomains: [] };
  }

  // Verify DNS write permission non-destructively before Wrangler deploys routes
  // and before any Custom Domain is detached.
  let created = null;
  try {
    created = await cf(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: {
        type: "TXT",
        name: PREFLIGHT_RECORD_NAME,
        content: `"esphub-dns-preflight-${Date.now()}"`,
        ttl: 60,
        comment: "Temporary permission check before migrating esphub-web to Workers Routes",
      },
    });
  } catch (err) {
    throw new Error(
      `CLOUDFLARE_API_TOKEN cannot write DNS records in zone "${ZONE_NAME}" (Zone:DNS:Edit is required before detaching Workers Custom Domains): ${err.message}`,
    );
  } finally {
    if (created?.id) {
      await cf(`/zones/${zoneId}/dns_records/${created.id}`, { method: "DELETE" });
    }
  }

  log(
    `Preflight OK: verified Zone:DNS:Edit and Workers Routes access (custom domains to detach: ${customDomains.map((d) => d.hostname).join(", ") || "none"}; placeholder DNS to create: ${missingHosts.join(", ") || "none"}).`,
  );
  return { zoneId, needsMigration: true, missingHosts, customDomains };
}

export async function applyWebDns({
  apiToken,
  accountId,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  log = console.log,
}) {
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  const cf = createCloudflareClient({ apiToken, fetchImpl });
  const zoneId = await resolveZoneId(cf, accountId);

  // Confirm replacement Zone Routes are active before detaching any Custom Domain.
  const routes = (await cf(`/zones/${zoneId}/workers/routes`)) ?? [];
  for (const host of WEB_HOSTNAMES) {
    const pattern = `${host}/*`;
    const route = routes.find((r) => r.pattern === pattern && r.script === WORKER_NAME);
    if (!route) {
      throw new Error(
        `Expected Workers Route "${pattern}" -> "${WORKER_NAME}" is not active on zone "${ZONE_NAME}"; aborting before detaching Custom Domains.`,
      );
    }
  }

  const customDomains = await listWorkerCustomDomains(cf, accountId);
  const customDomainByHost = new Map(customDomains.map((d) => [d.hostname, d]));
  const detached = [];
  const created = [];

  for (const host of WEB_HOSTNAMES) {
    const existingDomain = customDomainByHost.get(host);
    if (existingDomain) {
      await cf(`/accounts/${accountId}/workers/domains/${existingDomain.id}`, {
        method: "DELETE",
      });
      detached.push(host);
      log(`Detached Workers Custom Domain ${host} (${existingDomain.id}).`);
    }

    const records = await listHostDnsRecords(cf, zoneId, host);
    const managed = findManagedRoutingRecords(records, host);
    if (managed.some((r) => r.proxied === true)) {
      log(`Proxied DNS record already exists for ${host}.`);
      continue;
    }
    if (managed.length > 0) {
      throw new Error(
        `Host "${host}" has unproxied DNS record(s); refusing to overwrite.`,
      );
    }

    let createdRecord = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        createdRecord = await cf(`/zones/${zoneId}/dns_records`, {
          method: "POST",
          body: {
            type: "AAAA",
            name: host,
            content: PLACEHOLDER_CONTENT,
            proxied: true,
            ttl: 1,
            comment: PLACEHOLDER_COMMENT,
          },
        });
        break;
      } catch (err) {
        if (attempt < retryDelaysMs.length && isRetryableDnsConflict(err)) {
          await sleep(retryDelaysMs[attempt]);
          continue;
        }
        throw err;
      }
    }
    created.push(host);
    log(`Created proxied AAAA ${PLACEHOLDER_CONTENT} placeholder DNS record for ${host} (${createdRecord?.id ?? "ok"}).`);
  }

  return { zoneId, detached, created };
}

async function main() {
  const mode = process.argv[2];
  const opts = {
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  };
  if (mode === "--preflight") {
    await preflightWebDns(opts);
  } else if (mode === "--apply") {
    await applyWebDns(opts);
  } else {
    throw new Error("Usage: node scripts/ensure-web-dns.mjs <--preflight|--apply>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
