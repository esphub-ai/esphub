import { createClerkClient } from "@clerk/backend";
import { browserOrigins, issuer } from "../../../shared/identity.js";
import { HTTPException } from "hono/http-exception";
export function fail(status, message) {
  throw new HTTPException(status, { message });
}
export async function digest(text) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).toString("hex");
}
export function token(prefix) {
  return (
    prefix +
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64url",
    )
  );
}
export function allowedOrigin(c, origin) {
  return (
    browserOrigins.includes(origin) || (!!origin && origin === c.env.APP_ORIGIN)
  );
}
const profileTtlMs = 24 * 60 * 60 * 1000;

export function isStaffEmail(email) {
  return typeof email === "string" && /^[^@\s]+@okou\.ai$/i.test(email.trim());
}

export function extractClerkProfile(user) {
  if (!user || typeof user !== "object") {
    return { display_name: null, avatar_url: null, email: null };
  }
  const username = typeof user.username === "string" ? user.username.trim() : "";
  const fullName = [user.firstName, user.lastName]
    .filter((part) => typeof part === "string" && part.trim())
    .join(" ")
    .trim();
  const display_name = (username || fullName || "").slice(0, 120) || null;
  const hasCustomAvatar = user.hasImage !== false && user.has_image !== false;
  const avatar_url =
    hasCustomAvatar &&
    typeof user.imageUrl === "string" &&
    user.imageUrl.startsWith("https://") &&
    user.imageUrl.length <= 512
      ? user.imageUrl
      : null;

  const emails = Array.isArray(user.emailAddresses) ? user.emailAddresses : [];
  const verified = emails.filter(
    (entry) =>
      entry?.verification?.status === "verified" &&
      typeof entry.emailAddress === "string" &&
      entry.emailAddress.includes("@"),
  );
  const primary = verified.find((entry) => entry.id === user.primaryEmailAddressId);
  const staff = verified.find((entry) => isStaffEmail(entry.emailAddress));
  const picked = primary || staff || verified[0] || null;
  const email = picked ? picked.emailAddress.trim().toLowerCase().slice(0, 320) : null;
  return { display_name, avatar_url, email };
}

export async function identify(c) {
  const raw = c.req.header("Authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!raw) fail(401, "Sign in required");
  const clerk = createClerkClient({
    secretKey: c.env.CLERK_SECRET_KEY,
    publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
    ...(c.env.CLERK_API_URL ? { apiUrl: c.env.CLERK_API_URL } : {}),
  });
  const state = await clerk.authenticateRequest(
    new Request(c.req.url, { headers: { Authorization: `Bearer ${raw}` } }),
    {
      acceptsToken: "session_token",
      jwtKey: c.env.CLERK_JWT_KEY,
      issuer,
      authorizedParties: c.env.APP_ORIGIN ? [...browserOrigins, c.env.APP_ORIGIN] : browserOrigins,
    },
  );
  if (state.reason === "jwk-remote-failed-to-load")
    fail(503, "Identity service unavailable");
  const auth = state.toAuth();
  if (!auth.isAuthenticated) fail(401, "Invalid or expired Clerk session");
  return accountForSubject(c.get("sql"), auth.userId, c.env);
}
export async function identifyApiSubject(c) {
  const raw = c.req.header("Authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!raw) fail(401, "API key or sign in required");
  if (!c.env.CLERK_SECRET_KEY) fail(503, "Identity service unavailable");
  const clerk = createClerkClient({
    secretKey: c.env.CLERK_SECRET_KEY,
    publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
    ...(c.env.CLERK_API_URL ? { apiUrl: c.env.CLERK_API_URL } : {}),
  });
  const state = await clerk.authenticateRequest(
    new Request(c.req.url, { headers: { Authorization: `Bearer ${raw}` } }),
    {
      acceptsToken: ["api_key", "session_token"],
      jwtKey: c.env.CLERK_JWT_KEY,
      issuer,
      authorizedParties: c.env.APP_ORIGIN
        ? [...browserOrigins, c.env.APP_ORIGIN]
        : browserOrigins,
    },
  );
  if (
    state.reason === "jwk-remote-failed-to-load" ||
    state.reason === "secret-key-invalid" ||
    (state.reason === "unexpected-error" &&
      /status=(?:5\d\d|n\/a)\)/.test(state.message ?? ""))
  )
    fail(503, "Identity service unavailable");
  const auth = state.toAuth();
  if (
    !auth.isAuthenticated ||
    (auth.tokenType !== "api_key" && auth.tokenType !== "session_token")
  )
    fail(401, "Invalid or expired credentials");
  if (auth.tokenType === "api_key" && !auth.userId)
    fail(403, "Personal user API key required");
  if (
    typeof auth.userId !== "string" ||
    !/^user_[a-zA-Z0-9]+$/.test(auth.userId)
  )
    fail(401, "Clerk user required");
  return { subject: auth.userId, tokenType: auth.tokenType };
}
export async function identifyApiUser(c) {
  const { subject, tokenType } = await identifyApiSubject(c);
  const account = await accountForSubject(c.get("sql"), subject, c.env);
  return { ...account, subject, tokenType };
}
export async function identifyMachine(c) {
  const raw = c.req.header("Authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!raw) fail(401, "Machine token required");
  const allowed = c.env.CLERK_BOOTLOADER_MACHINE_ID;
  if (!allowed) fail(503, "Machine authentication unavailable");
  const clerk = createClerkClient({
    secretKey: c.env.CLERK_SECRET_KEY,
    machineSecretKey: c.env.CLERK_MACHINE_SECRET_KEY,
    publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
  });
  const state = await clerk.authenticateRequest(
    new Request(c.req.url, { headers: { Authorization: `Bearer ${raw}` } }),
    {
      acceptsToken: "m2m_token",
      jwtKey: c.env.CLERK_JWT_KEY,
    },
  );
  if (state.reason === "jwk-remote-failed-to-load")
    fail(503, "Identity service unavailable");
  const auth = state.toAuth();
  if (!auth.isAuthenticated || auth.tokenType !== "m2m_token")
    fail(401, "Invalid or expired machine token");
  if (auth.subject !== allowed) fail(403, "Machine not authorized");
  if (
    c.env.CLERK_API_MACHINE_ID &&
    (!Array.isArray(auth.scopes) ||
      !auth.scopes.includes(c.env.CLERK_API_MACHINE_ID))
  )
    fail(403, "Machine scope not authorized");
  return { id: auth.id, subject: auth.subject, scopes: auth.scopes };
}
export async function accountForSubject(sql, subject, env) {
  if (typeof subject !== "string" || !/^user_[a-zA-Z0-9]+$/.test(subject))
    fail(401, "Clerk user required");
  let [account] =
    await sql`SELECT id AS owner, display_name, avatar_url, email, profile_synced_at
      FROM esphub.accounts
      WHERE clerk_subject=${subject}`;
  if (!account) {
    [account] =
      await sql`INSERT INTO esphub.accounts(clerk_subject)
        VALUES(${subject})
        ON CONFLICT(clerk_subject) DO UPDATE SET clerk_subject=excluded.clerk_subject
        RETURNING id AS owner, display_name, avatar_url, email, profile_synced_at`;
  }
  const syncedAt = account.profile_synced_at ? Date.parse(account.profile_synced_at) : 0;
  const stale = !syncedAt || Date.now() - syncedAt > profileTtlMs;
  if (stale && env?.CLERK_SECRET_KEY) {
    try {
      const clerk = createClerkClient({
        secretKey: env.CLERK_SECRET_KEY,
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
        ...(env.CLERK_API_URL ? { apiUrl: env.CLERK_API_URL } : {}),
      });
      const user = await clerk.users.getUser(subject);
      const profile = extractClerkProfile(user);
      const [updated] = await sql`UPDATE esphub.accounts
        SET display_name = ${profile.display_name},
            avatar_url = ${profile.avatar_url},
            email = ${profile.email},
            profile_synced_at = now()
        WHERE id = ${account.owner}
        RETURNING id AS owner, display_name, avatar_url, email, profile_synced_at`;
      if (updated) account = updated;
    } catch {
      // Keep existing cached profile when Clerk user lookup is unavailable.
    }
  }
  return {
    owner: account.owner,
    display_name: account.display_name ?? null,
    avatar_url: account.avatar_url ?? null,
    email: account.email ?? null,
    is_staff: isStaffEmail(account.email),
  };
}
