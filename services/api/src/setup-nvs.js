// Short-lived private setup NVS image staging in the Device Durable Object + R2.
import { apiOrigin } from "../../../shared/identity.js";
import { digest, token } from "./auth.js";

const SETUP_TTL_MS = 15 * 60000;
const error = (status, message) =>
  Response.json({ error: message }, { status });
const objectKey = (row) => `devices/${row.device}/setup/${row.id}`;

async function sha256Hex(bytes) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString(
    "hex",
  );
}

export class SetupNvs {
  constructor(ctx, bucket) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.db = ctx.storage.sql;
    this.bucket = bucket;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS setup_nvs(id TEXT PRIMARY KEY, device TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, credential_hash TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
  }

  async stage(device, offset, request) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const id = crypto.randomUUID();
    const credential = token("eh_nvs_");
    const expires = Date.now() + SETUP_TTL_MS;
    const sha256 = await sha256Hex(bytes);
    const key = objectKey({ device, id });
    await this.bucket.put(key, bytes);
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > expires) await this.storage.setAlarm(expires);
    this.db.exec(
      "INSERT INTO setup_nvs VALUES(?,?,?,?,?,?)",
      id,
      device,
      bytes.byteLength,
      sha256,
      await digest(credential),
      expires,
    );
    return Response.json({
      url: `${apiOrigin}/setup/${device}/${id}`,
      headers: { Authorization: "Bearer " + credential },
      offset: "0x" + Number(offset).toString(16),
      size: bytes.byteLength,
      sha256,
      expires_at: new Date(expires).toISOString(),
    });
  }

  row(id) {
    return this.db
      .exec("SELECT * FROM setup_nvs WHERE id=? AND expires>?", id, Date.now())
      .toArray()[0];
  }

  async download(id, request) {
    const row = this.row(id);
    const secret = request.headers
      .get("Authorization")
      ?.match(/^Bearer (eh_nvs_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!row || !secret || row.credential_hash !== (await digest(secret)))
      return error(403, "Invalid or expired setup credential");
    const object = await this.bucket.get(objectKey(row));
    if (!object) return error(404, "Setup image unavailable");
    const stream = new FixedLengthStream(object.size);
    this.ctx.waitUntil(object.body.pipeTo(stream.writable));
    return new Response(stream.readable, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  async revokeAll() {
    const rows = this.db.exec("SELECT id, device FROM setup_nvs").toArray();
    if (rows.length) {
      await this.bucket.delete(rows.map(objectKey));
      this.db.exec("DELETE FROM setup_nvs");
    }
  }

  async expire() {
    const expired = this.db
      .exec(
        "SELECT id, device FROM setup_nvs WHERE expires<=? LIMIT 100",
        Date.now(),
      )
      .toArray();
    if (expired.length) {
      await this.bucket.delete(expired.map(objectKey));
      for (const row of expired)
        this.db.exec("DELETE FROM setup_nvs WHERE id=?", row.id);
    }
  }

  nextExpiry() {
    return this.db.exec("SELECT min(expires) AS expires FROM setup_nvs").one()
      .expires;
  }
}
