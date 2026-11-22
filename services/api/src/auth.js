import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
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
export async function identify(c, allowCookie = true) {
  const bearer = c.req
    .header("Authorization")
    ?.match(/^Bearer (esh_key_[A-Za-z0-9_-]+)$/)?.[1];
  const raw = bearer || (allowCookie && getCookie(c, "__Host-esphub"));
  if (!raw) fail(401, "Sign in required");
  const sql = c.get("sql");
  const [row] =
    await sql`SELECT t.owner,a.handle,t.kind FROM esphub.access_tokens t JOIN esphub.accounts a ON a.id=t.owner WHERE digest=${await digest(raw)} AND kind=${bearer ? "developer" : "session"} AND expires_at>now()`;
  if (!row) fail(401, "Credential expired or revoked");
  return row;
}
export function installAuth(app) {
  app.post("/auth/:mode/options", async (c) => {
    const mode = c.req.param("mode"),
      { handle: input } = await c.req.json(),
      handle = String(input || "")
        .trim()
        .toLowerCase();
    if (
      !["register", "login"].includes(mode) ||
      !/^[a-z0-9_-]{3,48}$/.test(handle)
    )
      fail(400, "Use a handle of 3–48 letters, numbers, dashes or underscores");
    const sql = c.get("sql"),
      origin = new URL(c.env.APP_ORIGIN),
      rpID = origin.hostname;
    const opts =
      mode === "register"
        ? await generateRegistrationOptions({
            rpName: "ESP Hub",
            rpID,
            userName: handle,
            attestationType: "none",
            authenticatorSelection: {
              residentKey: "required",
              userVerification: "required",
            },
          })
        : await generateAuthenticationOptions({
            rpID,
            userVerification: "required",
          });
    const [r] =
      await sql`INSERT INTO esphub.challenges(challenge,handle,purpose) VALUES(${opts.challenge},${handle},${mode}) RETURNING id`;
    return c.json({ id: r.id, options: opts });
  });
  app.post("/auth/:mode/verify", async (c) => {
    const { id, response } = await c.req.json();
    const sql = c.get("sql"),
      mode = c.req.param("mode"),
      origin = c.env.APP_ORIGIN;
    const [row] =
      await sql`DELETE FROM esphub.challenges WHERE id=${id} AND purpose=${mode} AND expires_at>now() RETURNING challenge,handle`;
    if (!row) fail(401, "Challenge expired");
    const opts = {
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: origin,
      expectedRPID: new URL(origin).hostname,
      requireUserVerification: true,
    };
    let owner;
    if (mode === "register") {
      const result = await verifyRegistrationResponse(opts).catch(() => null);
      if (!result?.verified) fail(401, "Passkey verification failed");
      const cred = result.registrationInfo.credential;
      const [registration] = await sql`
        WITH account AS (
          INSERT INTO esphub.accounts(handle) VALUES(${row.handle})
          ON CONFLICT DO NOTHING RETURNING id
        )
        INSERT INTO esphub.credentials(id,owner,public_key,counter)
        SELECT ${cred.id},id,${Buffer.from(cred.publicKey).toString("base64url")},${cred.counter} FROM account
        RETURNING owner`;
      if (!registration) fail(409, "Handle already registered");
      owner = registration.owner;
    } else {
      const [cred] =
        await sql`SELECT k.* FROM esphub.credentials k JOIN esphub.accounts a ON a.id=k.owner WHERE k.id=${response.id} AND a.handle=${row.handle}`;
      if (!cred) fail(401, "Passkey verification failed");
      const result = await verifyAuthenticationResponse({
        ...opts,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64url")),
          counter: Number(cred.counter),
        },
      }).catch(() => null);
      if (!result?.verified) fail(401, "Passkey verification failed");
      const updated =
        await sql`UPDATE esphub.credentials SET counter=${result.authenticationInfo.newCounter} WHERE id=${cred.id} AND counter=${cred.counter} RETURNING id`;
      if (!updated.length) fail(409, "Passkey counter changed; sign in again");
      owner = cred.owner;
    }
    const secret = token("esh_session_");
    await sql`INSERT INTO esphub.access_tokens(digest,owner,kind,expires_at) VALUES(${await digest(secret)},${owner},'session',now()+interval '7 days')`;
    setCookie(c, "__Host-esphub", secret, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 604800,
    });
    return c.json({ handle: row.handle });
  });
  app.get("/auth/me", async (c) =>
    c.json({ handle: (await identify(c)).handle }),
  );
  app.post("/auth/logout", async (c) => {
    const sql = c.get("sql");
    await sql`DELETE FROM esphub.access_tokens WHERE digest=${await digest(getCookie(c, "__Host-esphub") || "")}`;
    deleteCookie(c, "__Host-esphub", {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    });
    return c.json({ signed_out: true });
  });
  app.post("/auth/key", async (c) => {
    const who = await identify(c);
    if (who.kind !== "session") fail(403, "Sign in with your passkey");
    const sql = c.get("sql"),
      key = token("esh_key_");
    await sql`INSERT INTO esphub.access_tokens(digest,owner,kind,expires_at)
        VALUES(${await digest(key)},${who.owner},'developer',now()+interval '90 days')
        ON CONFLICT (owner) WHERE kind='developer' DO UPDATE SET
          digest=excluded.digest, expires_at=excluded.expires_at, created_at=now()`;
    return c.json({ key, expires_in_days: 90 });
  });
}
