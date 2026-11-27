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
  return accountForSubject(c.get("sql"), auth.userId);
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
  const account = await accountForSubject(c.get("sql"), subject);
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
export async function accountForSubject(sql, subject) {
  if (typeof subject !== "string" || !/^user_[a-zA-Z0-9]+$/.test(subject))
    fail(401, "Clerk user required");
  const [existing] =
    await sql`SELECT id AS owner FROM esphub.accounts WHERE clerk_subject=${subject}`;
  if (existing) return existing;
  const [account] =
    await sql`INSERT INTO esphub.accounts(clerk_subject) VALUES(${subject}) ON CONFLICT(clerk_subject) DO UPDATE SET clerk_subject=excluded.clerk_subject RETURNING id AS owner`;
  return account;
}
