import { maxAppSize, validLayout } from "./layout.js";
import { normalizeBleAddress } from "./ble.js";
import { withDatabase } from "./database.js";
import { dispatch, enqueue, finishResize, receipt, retryDue, nextRetry } from "./commands.js";
import { DurableObject } from "cloudflare:workers";
import { connectedSince } from "./iot.js";
import { Uploads } from "./uploads.js";
import { SetupNvs } from "./setup-nvs.js";
import { Stream } from "./streams.js";
import { softwareInventory } from "./software.js";
import { uuidPattern } from "./ids.js";
export class Device extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.uploads = new Uploads(ctx, env.UART);
    this.setupNvs = new SetupNvs(ctx, env.UART);
    this.db = ctx.storage.sql;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS boots(pid TEXT PRIMARY KEY,info TEXT); CREATE INDEX IF NOT EXISTS boots_software_ble ON boots(json_extract(info,'$.role'), json_extract(info,'$.ble_address')); CREATE TABLE IF NOT EXISTS current_device(pid TEXT); CREATE TABLE IF NOT EXISTS uplink_events(mid INTEGER PRIMARY KEY)",
    );
  }
  software(info) {
    const other = info?.role === "app" ? "bootloader" : "app";
    const row = info?.ble_address
      ? this.db.exec(
          "SELECT info FROM boots WHERE json_extract(info,'$.role')=? AND json_extract(info,'$.ble_address')=? ORDER BY rowid DESC LIMIT 1",
          other, info.ble_address,
        ).toArray()[0]
      : null;
    return softwareInventory(info, row && JSON.parse(row.info));
  }
  current() {
    return this.db.exec("SELECT * FROM current_device").toArray()[0];
  }
  stream(device, pid) {
    return new Stream(
      this.env.UART,
      "devices/" + device + "/" + pid + "/uart/tx",
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
    await this.uploads.expire();
    await this.setupNvs.expire();
    const next = this.db
      .exec(
        "SELECT min(expires) AS expires FROM uploads",
      )
      .one().expires;
    const nextSetup = this.setupNvs.nextExpiry();
    let retry;
    const id = await this.ctx.storage.get("commandDevice");
    if (id) {
      retry = await withDatabase(this.env, async (db) => {
        await retryDue(db, this.env, id);
        return nextRetry(db, id);
      });
      if (!retry) await this.ctx.storage.delete("commandDevice");
    }
    const earliest = Math.min(next ?? Infinity, nextSetup ?? Infinity, retry ?? Infinity);
    if (Number.isFinite(earliest)) await this.ctx.storage.setAlarm(earliest);
  }
  async fetch(req) {
    const url = new URL(req.url),
      path = url.pathname;
    if (path.startsWith("/uploads/") && req.method === "PUT")
      return this.uploads.put(path.slice("/uploads/".length), req);
    if (path.startsWith("/artifacts/"))
      return this.uploads.download(path.slice("/artifacts/".length));
    if (path === "/stage-nvs" && req.method === "POST")
      return this.setupNvs.stage(
        url.searchParams.get("device"),
        url.searchParams.get("offset"),
        req,
      );
    if (path.startsWith("/setup-nvs/") && req.method === "GET")
      return this.setupNvs.download(path.slice("/setup-nvs/".length), req);
    const boot = this.current()?.pid;
    if (path === "/summary") {
      const row =
        boot &&
        this.db.exec("SELECT info FROM boots WHERE pid=?", boot).toArray()[0];
      const info = row ? JSON.parse(row.info) : null;
      return Response.json({
        process_id: boot || null,
        software: this.software(info),
      });
    }
    if (path === "/revoke") {
      const { device } = await req.json();
      await this.armCommands(device);
      await this.setupNvs.revokeAll();
      this.db.exec("UPDATE uploads SET write_until=0 WHERE write_until>0");
      this.db.exec("DELETE FROM current_device");
      return Response.json({ revoked: true });
    }
    const args = await req.json();
    if (path === "/logs") {
      const pid = args.process_id ?? boot;
      if (!pid)
        return Response.json({ process_id: null, records: [], cursor: 0, last: 0 });
      if (!this.db.exec("SELECT 1 FROM boots WHERE pid=?", pid).toArray().length)
        return Response.json({ error: "Unknown boot" }, { status: 404 });
      const page = await this.stream(args.device_id, pid).read(
        args.after ?? 0,
        args.limit ?? 16,
      );
      return Response.json({ process_id: pid, ...page });
    }
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
    if (path === "/check-upload") {
      const size = await this.uploads.readySize(args.url, args.kind);
      return size
        ? Response.json({ ready: true, size })
        : Response.json({ error: "Upload not ready" }, { status: 409 });
    }
    if (path === "/uplink") {
      return this.ctx.blockConcurrencyWhile(() => this.uplink(args));
    }
    if (path === "/prepare-upload") return this.uploads.prepare(args);
    return new Response(null, { status: 404 });
  }
  async uplink({ device, principal, frame: m }) {
    const pid = m.boot_id;
    return withDatabase(this.env, async (db) => {
      const [d] =
        await db`SELECT boot_id,boot_info FROM esphub.devices WHERE id=${device}
        AND cert_ready AND cert_id=${principal}`;
      if (!d)
        return Response.json({ error: "Stale enrollment" }, { status: 409 });
      if (m.t === "hello") {
        if (!["app", "bootloader"].includes(m.role))
          return Response.json(
            { error: "Invalid role" },
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
        const bleAddress = normalizeBleAddress(m.ble_address);
        const info = JSON.stringify({
          role: m.role,
          ble_address: bleAddress,
          net_mac: m.net_mac,
          bootloader_version: m.bootloader_version,
          fw: m.fw,
          sdk_version: m.sdk_version,
          ...(d.boot_id === pid && m.role === "bootloader" && validLayout(d.boot_info?.layout)
            ? { layout: d.boot_info.layout } : {}),
        });
        const rows =
          await db`UPDATE esphub.devices SET boot_id=${pid},mqtt_connected_since=${session},boot_info=${info}::text::jsonb,
          ble_address=COALESCE(${bleAddress}::macaddr,ble_address)
          WHERE id=${device} AND cert_id=${principal} RETURNING id`;
        if (!rows.length)
          return Response.json({ error: "Stale enrollment" }, { status: 409 });
        if (this.current()?.pid !== pid)
          this.db.exec("DELETE FROM uplink_events");
        this.db.exec("DELETE FROM current_device");
        this.db.exec("INSERT INTO current_device(pid) VALUES(?)", pid);
        this.db.exec(
          "INSERT INTO boots(pid,info) VALUES(?,?) ON CONFLICT(pid) DO UPDATE SET info=excluded.info",
          pid,
          info,
        );
        await dispatch(db, this.env, device, pid, true);
        return Response.json({});
      }
      if (d.boot_id !== pid || this.current()?.pid !== pid)
        return Response.json({ error: "Hello required" }, { status: 409 });
      const saveLayout = async (layout) => {
        if (d.boot_info?.role === "bootloader" && validLayout(layout)) {
          const value = JSON.stringify({ app_size_bytes: layout.app_size_bytes, data_size_bytes: layout.data_size_bytes });
          await db`UPDATE esphub.devices SET boot_info=jsonb_set(boot_info,'{layout}',${value}::text::jsonb)
            WHERE id=${device} AND boot_id=${pid}`;
        }
      };
      if (m.t === "res") {
        if (
          typeof m.ok !== "boolean" ||
          !uuidPattern.test(m.id)
        )
          return Response.json({ error: "Invalid receipt" }, { status: 400 });
        try {
          await receipt(db, device, pid, m);
          if (m.ok && Array.isArray(m.data?.partitions)) {
            const app = m.data.partitions.find((p) => p?.label === "app");
            const data = m.data.partitions.find((p) => p?.label === "data");
            if (app && data && app.offset + app.size === data.offset)
              await saveLayout({ app_size_bytes: app.size, data_size_bytes: data.size });
          }
          await dispatch(db, this.env, device);
        } catch (e) {
          if (e.status === 409)
            return Response.json({ error: e.message }, { status: 409 });
          throw e;
        }
        return Response.json({});
      }
      if (m.t === "message") {
        if (
          !Object.hasOwn(m, "payload") ||
          new TextEncoder().encode(JSON.stringify(m.payload)).length > 1024 ||
          (Object.hasOwn(m, "reply_to") &&
            (typeof m.reply_to !== "string" ||
              !uuidPattern.test(
                m.reply_to,
              ))) ||
          m.confirm === true
        )
          return Response.json(
            { error: "Invalid device message" },
            { status: 400 },
          );
        await this.recordEvent(device, pid, m.mid, {
          type: "message",
          payload: m.payload,
          ...(m.reply_to ? { reply_to: m.reply_to } : {}),
        });
        return Response.json({});
      }
      if (m.t === "log") {
        // Bound decoding before allocating and keep arbitrary console bytes out
        // of the relay's own logs. The SDK sends at most 384 bytes per batch.
        if (
          typeof m.bytes !== "string" ||
          !m.bytes.length || m.bytes.length > 512 || m.bytes.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(m.bytes) ||
          !Number.isInteger(m.dropped) || m.dropped < 0 || m.dropped > 0xffffffff
        )
          return Response.json({ error: "Invalid log batch" }, { status: 400 });
        const bytes = Uint8Array.from(atob(m.bytes), (c) => c.charCodeAt(0));
        await this.recordEvent(device, pid, m.mid, {
          text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
          dropped_bytes: m.dropped,
        });
        return Response.json({});
      }
      if (m.t !== "event")
        return Response.json({ error: "Unknown frame" }, { status: 400 });
      if (m.name === "ota.layout") await saveLayout(m.data);
      if (
        ["install.done", "install.failed"].includes(m.name) &&
        uuidPattern.test(
          m.data?.transfer_id,
        )
      ) {
        const done = m.name === "install.done";
        if (m.data.kind === "resize_app") {
          if (d.boot_info?.role !== "bootloader")
            return Response.json({ error: "Launcher required" }, { status: 409 });
          await finishResize(db, device, pid, done, m.data);
        } else {
          let outcome = m.data;
          const layout = d.boot_info?.layout;
          if (!done && m.data.kind === "app" && m.data.error === "Download exceeds target size" && validLayout(layout)) {
            outcome = { ...m.data, app_size_bytes: layout.app_size_bytes, max_app_size_bytes: maxAppSize(layout),
              image_size_at_least: layout.app_size_bytes + 1 };
          }
          await db`UPDATE esphub.device_commands SET state=${done ? "succeeded" : "failed"},
            result=${JSON.stringify(outcome)}::text::jsonb,args='{}',next_wake=NULL
            WHERE device_id=${device} AND request_id=${m.data.transfer_id} AND operation='install'
            AND state IN ('dispatched','unknown')`;
        }
        await dispatch(db, this.env, device);
      }
      if (typeof m.name === "string")
        await this.recordEvent(device, pid, m.mid, {
          text: m.name + " " + JSON.stringify(m.data ?? {}),
        });
      return Response.json({});
    });
  }
  async recordEvent(device, pid, mid, record) {
    const tx = this.stream(device, pid);
    // QoS 1 and the relay can redeliver out of order. Repair a previous R2
    // append if the process stopped before its SQLite dedup entry was written.
    if (
      this.db
        .exec("SELECT mid FROM uplink_events WHERE mid=?", mid)
        .toArray().length
    )
      return;
    const head = await tx.head();
    if (head.telemetryMid)
      this.db.exec(
        "INSERT OR IGNORE INTO uplink_events VALUES(?)",
        head.telemetryMid,
      );
    if (head.telemetryMid === mid) return;
    await tx.append(
      [
        {
          at: new Date().toISOString(),
          mid,
          ...record,
        },
      ],
      { telemetryMid: mid },
    );
    this.db.exec("INSERT OR IGNORE INTO uplink_events VALUES(?)", mid);
  }
}
