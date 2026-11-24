import { normalizeBleAddress } from "./ble.js";
import { withDatabase } from "./database.js";
import { dispatch, enqueue, receipt, retryDue, nextRetry } from "./commands.js";
import { DurableObject } from "cloudflare:workers";
import { connectedSince } from "./iot.js";
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
    return new Response(null, { status: 404 });
  }
  async uplink({ device, principal, frame: m }) {
    const pid = m.boot_id;
    return withDatabase(this.env, async (db) => {
      const [d] =
        await db`SELECT board,boot_id FROM esphub.devices WHERE id=${device}
        AND cert_ready AND cert_id=${principal}`;
      if (!d)
        return Response.json({ error: "Stale enrollment" }, { status: 409 });
      if (m.t === "hello") {
        if (d.board !== m.board || !["app", "bootloader"].includes(m.role))
          return Response.json(
            { error: "Board or role mismatch" },
            { status: 409 },
          );
        if (
          d.boot_id !== pid &&
          this.db.exec("SELECT pid FROM boots WHERE pid=?", pid).toArray()
            .length
        )
          return Response.json({ error: "Stale boot" }, { status: 409 });
        const session = await connectedSince(this.env, device);
        if (!session)
          return Response.json(
            { error: "MQTT session closed" },
            { status: 409 },
          );
        const rows =
          await db`UPDATE esphub.devices SET boot_id=${pid},mqtt_connected_since=${session},boot_info=${JSON.stringify(m)}::text::jsonb,
          ble_address=COALESCE(${normalizeBleAddress(m.ble_address)}::macaddr,ble_address)
          WHERE id=${device} AND cert_id=${principal} RETURNING id`;
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
        await dispatch(db, this.env, device, pid, true);
        return Response.json({});
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
          await dispatch(db, this.env, device);
        } catch (e) {
          if (e.status === 409)
            return Response.json({ error: e.message }, { status: 409 });
          throw e;
        }
        return Response.json({});
      }
      if (m.t !== "event")
        return Response.json({ error: "Unknown frame" }, { status: 400 });
      if (
        ["install.done", "install.failed"].includes(m.name) &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
          m.data?.transfer_id,
        )
      ) {
        // The bootloader can resume a saved transfer in a subsequent boot.
        await db`UPDATE esphub.device_commands SET state=${m.name === "install.done" ? "succeeded" : "failed"},
          result=${JSON.stringify(m.data)}::text::jsonb,args='{}',next_wake=NULL
          WHERE device_id=${device} AND request_id=${m.data.transfer_id} AND operation='install' AND state IN ('dispatched','unknown')`;
        await dispatch(db, this.env, device);
      }
      if (typeof m.name === "string") await this.recordEvent(pid, m);
      return Response.json({});
    });
  }
  async recordEvent(pid, m) {
    const tx = this.stream(pid, "tx");
    // QoS 1 and the relay can redeliver out of order. Repair a previous R2
    // append if the process stopped before its SQLite dedup entry was written.
    if (
      this.db
        .exec("SELECT mid FROM uplink_events WHERE mid=?", m.mid)
        .toArray().length
    )
      return;
    const head = await tx.head();
    if (head.telemetryMid)
      this.db.exec(
        "INSERT OR IGNORE INTO uplink_events VALUES(?)",
        head.telemetryMid,
      );
    if (head.telemetryMid === m.mid) return;
    await tx.append(
      [
        {
          at: new Date().toISOString(),
          text: m.name + " " + JSON.stringify(m.data ?? {}),
        },
      ],
      { telemetryMid: m.mid },
    );
    this.db.exec("INSERT OR IGNORE INTO uplink_events VALUES(?)", m.mid);
  }
}
