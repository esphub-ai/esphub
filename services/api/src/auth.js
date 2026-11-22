import { createRemoteJWKSet, jwtVerify } from "jose";
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
const keySets = new Map();
export function allowedOrigin(c, origin) {
  return (
    browserOrigins.includes(origin) || (!!origin && origin === c.env.APP_ORIGIN)
  );
}
export async function identify(c, allowSession = true) {
  const header = c.req.header("Authorization");
  const bearer = header?.match(/^Bearer (\S+)$/i)?.[1];
  const sql = c.get("sql");
  if (bearer?.startsWith("esh_key_")) {
    const [row] =
      await sql`SELECT t.owner,a.handle,t.kind FROM esphub.access_tokens t JOIN esphub.accounts a ON a.id=t.owner WHERE digest=${await digest(bearer)} AND kind='developer' AND expires_at>now()`;
    if (!row) fail(401, "Credential expired or revoked");
    return row;
  }
  const raw = bearer || (!header && getCookie(c, "__session"));
  if (!allowSession || !raw) fail(401, "Sign in required");
  const source = c.env.CLERK_ISSUER || issuer;
  if (!keySets.has(source))
    keySets.set(
      source,
      createRemoteJWKSet(new URL("/.well-known/jwks.json", source)),
    );
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(raw, keySets.get(source), {
      issuer: source,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "sid", "azp"],
    }));
  } catch (err) {
    if (err.code === "ERR_JWKS_TIMEOUT" || err instanceof TypeError)
      fail(503, "Identity service unavailable");
    fail(401, "Invalid or expired Clerk session");
  }
  if (
    !allowedOrigin(c, claims.azp) ||
    !/^user_[a-zA-Z0-9]+$/.test(claims.sub) ||
    !claims.sid ||
    claims.sts === "pending"
  )
    fail(401, "Invalid Clerk session");
  const [existing] =
    await sql`SELECT id AS owner,handle FROM esphub.accounts WHERE clerk_subject=${claims.sub}`;
  if (existing) return { ...existing, kind: "session" };
  const [account] =
    await sql`INSERT INTO esphub.accounts(handle,clerk_subject) VALUES(${"clerk:" + claims.sub},${claims.sub}) ON CONFLICT(clerk_subject) DO UPDATE SET clerk_subject=excluded.clerk_subject RETURNING id AS owner,handle`;
  return { ...account, kind: "session" };
}
export function installAuth(app) {
  app.get("/auth/me", async (c) =>
    c.json({ handle: (await identify(c)).handle }),
  );
  app.post("/auth/key", async (c) => {
    const who = await identify(c);
    if (who.kind !== "session") fail(403, "Sign in with Clerk");
    const sql = c.get("sql"),
      key = token("esh_key_");
    await sql`INSERT INTO esphub.access_tokens(digest,owner,kind,expires_at)
        VALUES(${await digest(key)},${who.owner},'developer',now()+interval '90 days')
        ON CONFLICT (owner) WHERE kind='developer' DO UPDATE SET
          digest=excluded.digest, expires_at=excluded.expires_at, created_at=now()`;
    return c.json({ key, expires_in_days: 90 });
  });
}
