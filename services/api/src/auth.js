import { createClerkClient } from "@clerk/backend";
import { getCookie } from "hono/cookie";
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
  const header = c.req.header("Authorization");
  const raw = header
    ? header.match(/^Bearer (\S+)$/i)?.[1]
    : getCookie(c, "__session");
  if (!raw) fail(401, "Sign in required");
  const clerk = createClerkClient({
    secretKey: c.env.CLERK_SECRET_KEY,
    publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
  });
  // Feed both existing credential carriers through Clerk's session-token verifier.
  const state = await clerk.authenticateRequest(
    new Request(c.req.url, { headers: { Authorization: `Bearer ${raw}` } }),
    {
      acceptsToken: "session_token",
      jwtKey: c.env.CLERK_JWT_KEY,
      issuer,
      authorizedParties: [...browserOrigins, c.env.APP_ORIGIN],
    },
  );
  if (state.reason === "jwk-remote-failed-to-load")
    fail(503, "Identity service unavailable");
  const auth = state.toAuth();
  if (!auth.isAuthenticated) fail(401, "Invalid or expired Clerk session");
  return accountForSubject(c.get("sql"), auth.userId);
}
export async function accountForSubject(sql, subject) {
  if (typeof subject !== "string" || !/^user_[a-zA-Z0-9]+$/.test(subject))
    fail(401, "Clerk user required");
  const [existing] =
    await sql`SELECT id AS owner,handle FROM esphub.accounts WHERE clerk_subject=${subject}`;
  if (existing) return existing;
  const [account] =
    await sql`INSERT INTO esphub.accounts(handle,clerk_subject) VALUES(${"clerk:" + subject},${subject}) ON CONFLICT(clerk_subject) DO UPDATE SET clerk_subject=excluded.clerk_subject RETURNING id AS owner,handle`;
  return account;
}
