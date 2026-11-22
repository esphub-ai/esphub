// Device-private R2 staging. The download prefix is understood by deployed launchers.
import { digest, token } from "./auth.js";
export const artifactBase = "https://api.esphub.ai/api/device/programs/r2-";
export const maxUploadBytes = 4 * 1024 * 1024;
const error = (status, message) =>
  Response.json({ error: message }, { status });
const objectKey = (row) => `devices/${row.device}/artifacts/${row.id}`;

export class Uploads {
  constructor(ctx, bucket) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.db = ctx.storage.sql;
    this.bucket = bucket;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, device TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, credential_hash TEXT NOT NULL, write_until INTEGER NOT NULL, expires INTEGER NOT NULL)",
    );
  }

  async allocate(device, kind, size, hash, writeUntil) {
    const id = crypto.randomUUID(),
      expires = Date.now() + 24 * 3600000;
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > expires) await this.storage.setAlarm(expires);
    this.db.exec(
      "INSERT INTO uploads VALUES(?,?,?,?,?,?,?)",
      id,
      device,
      kind,
      size,
      hash,
      writeUntil,
      expires,
    );
    return { id, device, expires };
  }

  async prepare({ device_id, kind, size }) {
    const credential = token("esh_upload_"),
      writeUntil = Date.now() + 15 * 60000;
    const row = await this.allocate(
      device_id,
      kind,
      size,
      await digest(credential),
      writeUntil,
    );
    return Response.json({
      method: "PUT",
      upload_url: `https://api.esphub.ai/uploads/${device_id}/${row.id}`,
      headers: { Authorization: "Bearer " + credential },
      upload_expires_at: new Date(writeUntil).toISOString(),
      url: artifactBase + row.id,
      expires_at: new Date(row.expires).toISOString(),
    });
  }

  async publish({ device_id, source }) {
    const bytes = new TextEncoder().encode(source);
    const row = await this.allocate(device_id, "python", bytes.length, "", 0);
    const saved = await this.save(row, bytes);
    if (!saved.ok) return saved;
    return Response.json({
      url: artifactBase + row.id,
      expires_at: new Date(row.expires).toISOString(),
    });
  }

  row(id) {
    return this.db
      .exec("SELECT * FROM uploads WHERE id=? AND expires>?", id, Date.now())
      .toArray()[0];
  }

  async put(id, request) {
    const row = this.row(id);
    const secret = request.headers
      .get("Authorization")
      ?.match(/^Bearer (esh_upload_[A-Za-z0-9_-]{43})$/)?.[1];
    if (
      !row ||
      !secret ||
      row.write_until <= Date.now() ||
      row.credential_hash !== (await digest(secret))
    )
      return error(403, "Invalid or expired upload credential");
    if (
      !request.body ||
      request.headers.get("Content-Length") !== String(row.size)
    )
      return error(400, "Send the file bytes with the declared Content-Length");
    return this.save(row, request.body);
  }

  async save(row, body) {
    const id = row.id;
    const saved = await this.bucket.put(objectKey(row), body, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (!saved) return error(409, "This artifact has already been uploaded");
    if (!this.row(id)) {
      await this.bucket.delete(objectKey(row));
      return error(410, "Artifact expired during upload");
    }
    return Response.json(
      { uploaded: true, size: saved.size, url: artifactBase + id },
      { status: 201 },
    );
  }

  async download(id) {
    const row = this.row(id);
    const object = row && (await this.bucket.get(objectKey(row)));
    if (!object) return error(404, "Artifact unavailable");
    const stream = new FixedLengthStream(object.size);
    this.ctx.waitUntil(object.body.pipeTo(stream.writable));
    return new Response(stream.readable, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type":
          row.kind === "python"
            ? "text/plain; charset=utf-8"
            : "application/octet-stream",
      },
    });
  }

  async ready(url, kind) {
    const row = this.row(url.slice(artifactBase.length));
    return row?.kind === kind && !!(await this.bucket.head(objectKey(row)));
  }

  async expire() {
    const expired = this.db
      .exec(
        "SELECT id, device FROM uploads WHERE expires<=? LIMIT 100",
        Date.now(),
      )
      .toArray();
    if (expired.length) {
      await this.bucket.delete(expired.map(objectKey));
      for (const row of expired)
        this.db.exec("DELETE FROM uploads WHERE id=?", row.id);
    }
  }
}
