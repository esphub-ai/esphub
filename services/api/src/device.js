import { withDatabase } from "./database.js";
import { enqueue, receipt, retryDue, nextRetry } from "./commands.js";
import { DurableObject } from "cloudflare:workers";
import { Uploads } from "./uploads.js";
import { Stream } from "./streams.js";
import { softwareInventory } from "./software.js";
export class Device extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.uploads = new Uploads(ctx, env.UART);
    this.db = ctx.storage.sql;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS boots(pid TEXT PRIMARY KEY,started TEXT,info TEXT); CREATE INDEX IF NOT EXISTS boots_software ON boots(json_extract(info,'$.role'), json_extract(info,'$.mac'), json_extract(info,'$.board')); CREATE TABLE IF NOT EXISTS current_device(id TEXT, pid TEXT); CREATE TABLE IF NOT EXISTS uplink_events(mid INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS programs(id TEXT PRIMARY KEY, source TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
  }
  software(info) {
    const other = info?.role === "app" ? "bootloader" : "app";
    const row =
      info?.mac &&
      this.db
        .exec(
          "SELECT info FROM boots WHERE json_extract(info,'$.role')=? AND json_extract(info,'$.mac')=? AND json_extract(info,'$.board')=? ORDER BY rowid DESC LIMIT 1",
          other,
          info.mac,
          info.board ?? "",
        )
        .toArray()[0];
    return softwareInventory(info, row && JSON.parse(row.info));
  }
  current() {
    return this.db.exec("SELECT * FROM current_device").toArray()[0];
  }
  stream(pid, dir) {
    return new Stream(
      this.env.UART,
      "devices/" + this.current().id + "/" + pid + "/uart/" + dir,
    );
  }
  async armCommands(device) {
    await this.ctx.storage.put("commandDevice", device);
    const at = Date.now() + 10000,
      previous = await this.ctx.storage.getAlarm();
    if (previous === null || at < previous) await this.ctx.storage.setAlarm(at);
  }
  async alarm() {
    return this.ctx.blockConcurrencyWhile(() => this.processAlarm());
  }
  async processAlarm() {
    this.db.exec("DELETE FROM programs WHERE expires<=?", Date.now());
    await this.uploads.expire();
    const next = this.db
      .exec(
        "SELECT min(expires) AS expires FROM (SELECT min(expires) AS expires FROM programs UNION ALL SELECT min(expires) FROM uploads)",
      )
      .one().expires;
    let retry;
    const id = await this.ctx.storage.get("commandDevice");
    if (id) {
      retry = await withDatabase(this.env, async (db) => {
        await retryDue(db, this.env, id);
        return nextRetry(db, id);
      });
      if (!retry) await this.ctx.storage.delete("commandDevice");
    }
    const earliest = Math.min(next ?? Infinity, retry ?? Infinity);
    if (Number.isFinite(earliest)) await this.ctx.storage.setAlarm(earliest);
  }
  async fetch(req) {
    const url = new URL(req.url),
      path = url.pathname;
    if (path.startsWith("/uploads/") && req.method === "PUT")
      return this.uploads.put(path.slice("/uploads/".length), req);
    if (path.startsWith("/artifacts/r2-"))
      return this.uploads.download(path.slice("/artifacts/r2-".length));
    if (path.startsWith("/artifacts/")) {
      const row = this.db
        .exec(
          "SELECT source FROM programs WHERE id=? AND expires>?",
          path.slice(11),
          Date.now(),
        )
        .toArray()[0];
      return row
        ? new Response(row.source, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            },
          })
        : new Response(null, { status: 404 });
    }
    const boot = this.current()?.pid;
    if (path === "/record-program") {
      const { pid, status, source } = await req.json();
      const current = this.current()?.pid;
      const row =
        current === pid &&
        this.db.exec("SELECT info FROM boots WHERE pid=?", pid).toArray()[0];
      if (
        !row ||
        softwareInventory(JSON.parse(row.info)).application?.kind !==
          "micropython"
      )
        return Response.json(
          { error: "Not the current MicroPython boot" },
          { status: 409 },
        );
      await this.ctx.storage.put("main.py", {
        process_id: pid,
        status,
        source,
      });
      return Response.json({ saved: true });
    }
    if (path === "/program") {
      const row =
        boot &&
        this.db.exec("SELECT info FROM boots WHERE pid=?", boot).toArray()[0];
      const app = this.software(row && JSON.parse(row.info)).application;
      if (app?.kind !== "micropython")
        return Response.json({ status: app ? "not_applicable" : "unreported" });
      const snapshot = await this.ctx.storage.get("main.py");
      return Response.json(
        snapshot?.process_id === app.process_id
          ? snapshot
          : { process_id: app.process_id, status: "unreported" },
      );
    }
    if (path === "/summary") {
      const row =
        boot &&
        this.db.exec("SELECT info FROM boots WHERE pid=?", boot).toArray()[0];
      const info = row ? JSON.parse(row.info) : null;
      return Response.json({
        process_id: boot || null,
        info,
        software: this.software(info),
      });
    }
    if (path === "/revoke") {
      const { device } = await req.json();
      await this.ctx.storage.delete("main.py");
      await this.armCommands(device);
      this.db.exec("UPDATE uploads SET write_until=0 WHERE write_until>0");
      this.db.exec("DELETE FROM current_device");
      return Response.json({ revoked: true });
    }
    if (path === "/sessions")
      return Response.json(
        this.db
          .exec(
            "SELECT pid AS process_id,started AS started_at FROM boots ORDER BY started DESC",
          )
          .toArray(),
      );
    const args = await req.json();
    if (path === "/enqueue")
      return this.ctx.blockConcurrencyWhile(async () => {
        await this.armCommands(args.device);
        try {
          return Response.json(
            await withDatabase(this.env, (sql) =>
              enqueue(
                { sql, env: this.env },
                args.device,
                args.op,
                args.args,
                args.boot,
                args.key,
              ),
            ),
          );
        } catch (error) {
          if (error.status === 409)
            return Response.json({ error: error.message }, { status: 409 });
          throw error;
        }
      });
    if (path === "/check-upload")
      return (await this.uploads.ready(args.url, args.kind))
        ? Response.json({ ready: true })
        : Response.json({ error: "Upload not ready" }, { status: 409 });
    if (path === "/uplink") {
      return this.ctx.blockConcurrencyWhile(() => this.uplink(args));
    }
    if (path === "/prepare-upload") return this.uploads.prepare(args);
    if (path === "/publish") return this.uploads.publish(args);
    if (path === "/read") {
      if (
        !this.db
          .exec("SELECT pid FROM boots WHERE pid=?", args.process_id)
          .toArray().length
      )
        return Response.json(
          { error: "Unknown boot session" },
          { status: 404 },
        );
      return Response.json(
        await this.stream(args.process_id, "tx").read(args.after),
      );
    }
    return new Response(null, { status: 404 });
  }
  async uplink({ device, principal, frame: m }) {
    const pid = m.boot_id;
    return withDatabase(this.env, async (db) => {
      const [d] =
        await db`SELECT board,boot_id FROM esphub.devices WHERE id=${device}
        AND cert_ready AND cert_id=${principal} AND enrolled_boot=${pid}`;
      if (!d)
        return Response.json({ error: "Stale enrollment" }, { status: 409 });
      if (m.t === "hello") {
        if (m.proto !== 2 || d.board !== m.board || !["app", "bootloader"].includes(m.role))
          return Response.json(
            { error: "Firmware protocol, board or role mismatch" },
            { status: 409 },
          );
        const rows =
          await db`UPDATE esphub.devices SET boot_id=${pid},boot_info=${JSON.stringify(m)}::text::jsonb
          WHERE id=${device} AND cert_id=${principal} AND enrolled_boot=${pid} RETURNING id`;
        if (!rows.length)
          return Response.json({ error: "Stale enrollment" }, { status: 409 });
        if (this.current()?.pid !== pid)
          this.db.exec("DELETE FROM uplink_events");
        this.db.exec("DELETE FROM current_device");
        this.db.exec(
          "INSERT INTO current_device(id,pid) VALUES(?,?)",
          device,
          pid,
        );
        this.db.exec(
          "INSERT INTO boots(pid,started,info) VALUES(?,?,?) ON CONFLICT(pid) DO UPDATE SET info=excluded.info",
          pid,
          new Date().toISOString(),
          JSON.stringify(m),
        );
        const tx = this.stream(pid, "tx");
        await tx.init();
        return Response.json({ seq: (await tx.head()).source });
      }
      if (d.boot_id !== pid || this.current()?.pid !== pid)
        return Response.json({ error: "Hello required" }, { status: 409 });
      if (m.t === "res") {
        if (
          typeof m.ok !== "boolean" ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(m.id)
        )
          return Response.json({ error: "Invalid receipt" }, { status: 400 });
        try {
          await receipt(db, device, pid, m);
        } catch (e) {
          if (e.status === 409)
            return Response.json({ error: e.message }, { status: 409 });
          throw e;
        }
        return Response.json({});
      }
      if (!["event", "metric", "log"].includes(m.t))
        return Response.json({ error: "Unknown frame" }, { status: 400 });
      if (
        m.t === "event" &&
        ["install.done", "install.failed"].includes(m.name) &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
          m.data?.transfer_id,
        )
      ) {
        // The bootloader can resume a saved transfer in a subsequent boot.
        await db`UPDATE esphub.device_commands SET state=${m.name === "install.done" ? "succeeded" : "failed"},
          result=${JSON.stringify(m.data)}::text::jsonb,args='{}',next_wake=NULL
          WHERE device_id=${device} AND request_id=${m.data.transfer_id} AND operation='install' AND state IN ('dispatched','unknown')`;
      }
      return Response.json((await this.recordFrame(pid, m)) ?? {});
    });
  }
  async recordFrame(pid, m) {
    if (
      m.t === "log" &&
      Array.isArray(m.lines) &&
      Number.isSafeInteger(m.seq)
    ) {
      const tx = this.stream(pid, "tx"),
        head = await tx.head();
      const rows = m.lines
        .map((v, i) => ({
          source_seq: m.seq + i,
          at: new Date().toISOString(),
          uptime_ms: v[0],
          level: v[1],
          text: String(v[2]),
        }))
        .filter((v) => v.source_seq > head.source);
      if (rows.length)
        await tx.append(rows, { source: rows.at(-1).source_seq });
      return { t: "ack", seq: rows.at(-1)?.source_seq ?? head.source };
    } else if (
      (m.t === "event" && typeof m.name === "string") ||
      (m.t === "metric" && Array.isArray(m.items))
    ) {
      const tx = this.stream(pid, "tx");
      // QoS 1 and the relay can redeliver out of order. Repair a previous R2
      // append if the process stopped before its SQLite dedup entry was written.
      if (
        this.db
          .exec("SELECT mid FROM uplink_events WHERE mid=?", m.mid)
          .toArray().length
      )
        return {};
      const head = await tx.head();
      if (head.telemetryMid)
        this.db.exec(
          "INSERT OR IGNORE INTO uplink_events VALUES(?)",
          head.telemetryMid,
        );
      if (head.telemetryMid === m.mid) return {};
      await tx.append(
        [
          {
            at: new Date().toISOString(),
            text:
              m.t === "metric"
                ? "metric " + JSON.stringify(m.items)
                : m.name + " " + JSON.stringify(m.data ?? {}),
          },
        ],
        { telemetryMid: m.mid },
      );
      this.db.exec("INSERT OR IGNORE INTO uplink_events VALUES(?)", m.mid);
    }
    return null;
  }
}
