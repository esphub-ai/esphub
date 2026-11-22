import { withDatabase } from "./database.js";
import { enqueue, retryDue, nextRetry } from "./commands.js";
import { DurableObject } from "cloudflare:workers";
import { Uploads, artifactBase } from "./uploads.js";
import { Stream } from "./streams.js";
function legacyRepl(info) {
  return (
    info?.role === "app" &&
    info.fw?.name === "micropython" &&
    info.image_profile !== "ESPHUB1/micropython/" + info.board
  );
}
export class Device extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    this.uploads = new Uploads(ctx, env.UART);
    this.db = ctx.storage.sql;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS boots(pid TEXT PRIMARY KEY,started TEXT,info TEXT,rx_cursor INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS current_device(id TEXT, pid TEXT); CREATE TABLE IF NOT EXISTS writes(pid TEXT,k TEXT,seq INTEGER,PRIMARY KEY(pid,k)); CREATE TABLE IF NOT EXISTS programs(id TEXT PRIMARY KEY, source TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
  }
  active() {
    return this.ctx.getWebSockets("device").find((s) => s.readyState === 1);
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
    if (path === "/connect") {
      const pair = new WebSocketPair();
      const old = this.active();
      if (old) old.close(1000, "Replaced");
      this.db.exec(
        "INSERT INTO current_device(id,pid) SELECT ?,NULL WHERE NOT EXISTS(SELECT 1 FROM current_device)",
        req.headers.get("X-Device-ID"),
      );
      this.ctx.acceptWebSocket(pair[1], ["device"]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const boot = this.current()?.pid,
      socket = this.active();
    if (path === "/summary") {
      const row =
        boot &&
        this.db.exec("SELECT info FROM boots WHERE pid=?", boot).toArray()[0];
      const info = row ? JSON.parse(row.info) : null;
      return Response.json({
        online: !!socket && socket.deserializeAttachment()?.pid === boot,
        process_id: boot || null,
        info,
        serial_input: !legacyRepl(info),
      });
    }
    if (path === "/revoke") {
      const { device } = await req.json();
      await this.armCommands(device);
      this.db.exec("UPDATE uploads SET write_until=0 WHERE write_until>0");
      if (socket) socket.close(1008, "Registration revoked");
      return Response.json({ revoked: true });
    }
    if (path === "/sessions")
      return Response.json(
        this.db
          .exec(
            "SELECT pid AS process_id,started AS started_at,rx_cursor FROM boots ORDER BY started DESC",
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
    if (path === "/mqtt-frame") {
      return this.ctx.blockConcurrencyWhile(async () => {
        const m = args.frame,
          pid = args.boot_id;
        if (m.t === "hello") {
          if (socket) socket.close(1000, "Transport changed");
          this.db.exec("DELETE FROM current_device");
          this.db.exec(
            "INSERT INTO current_device(id,pid) VALUES(?,?)",
            args.device_id,
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
          return Response.json({ t: "ack", seq: (await tx.head()).source });
        }
        if (this.current()?.pid !== pid)
          return Response.json({ error: "Stale boot" }, { status: 409 });
        return Response.json(await this.recordFrame(pid, m));
      });
    }
    if (path === "/prepare-upload") return this.uploads.prepare(args);
    if (path === "/publish") {
      const id = crypto.randomUUID(),
        expires = Date.now() + 24 * 3600000;
      this.db.exec(
        "INSERT INTO programs VALUES(?,?,?)",
        id,
        args.source,
        expires,
      );
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(expires);
      return Response.json({
        url: "https://api.esphub.ai/api/device/programs/" + id,
        expires_at: new Date(expires).toISOString(),
      });
    }
    if (path === "/read" || path === "/write") {
      const pid = args.process_id;
      if (
        !this.db.exec("SELECT pid FROM boots WHERE pid=?", pid).toArray().length
      )
        return Response.json(
          { error: "Unknown boot session" },
          { status: 404 },
        );
      if (path === "/read")
        return Response.json(await this.stream(pid, "tx").read(args.after));
      if (
        !socket ||
        boot !== pid ||
        socket.deserializeAttachment()?.pid !== pid
      )
        return Response.json(
          { error: "Session is no longer active" },
          { status: 409 },
        );
      if (this.legacyRepl(pid))
        return Response.json(
          {
            error: "Update MicroPython over HTTPS to enable application input",
          },
          { status: 409 },
        );
      return this.ctx.blockConcurrencyWhile(async () => {
        const old = this.db
          .exec(
            "SELECT seq FROM writes WHERE pid=? AND k=?",
            pid,
            args.request_id,
          )
          .toArray()[0];
        if (old) return Response.json({ queued: true, sequence: old.seq });
        const rx = this.stream(pid, "rx"),
          head = await rx.head();
        // Repair the only possible gap if the previous append committed in R2
        // before its idempotency entry reached durable SQLite.
        if (head.key)
          this.db.exec(
            "INSERT OR IGNORE INTO writes VALUES(?,?,?)",
            pid,
            head.key,
            head.last,
          );
        this.rxLast = head.last;
        if (head.key === args.request_id)
          return Response.json({ queued: true, sequence: head.last });
        const n = await rx.append(
          [{ at: new Date().toISOString(), text: args.text }],
          { key: args.request_id },
        );
        this.rxLast = n.last;
        this.db.exec(
          "INSERT INTO writes VALUES(?,?,?)",
          pid,
          args.request_id,
          n.last,
        );
        return Response.json({ queued: true, sequence: n.last });
      });
    }
    if (!socket || !boot || socket.deserializeAttachment()?.pid !== boot)
      return Response.json({ error: "Device offline" }, { status: 409 });
    if (path === "/enter" || path === "/ota") {
      const info = JSON.parse(
        this.db.exec("SELECT info FROM boots WHERE pid=?", boot).one().info,
      );
      if (info.board !== args.board || !["launcher", "app"].includes(info.role))
        return Response.json(
          {
            error: "Connected device must report the registered board profile",
          },
          { status: 409 },
        );
      if (path === "/enter") {
        const already = info.role === "launcher";
        const response = await this.rpc(
          socket,
          already ? "status" : "reboot",
          already ? {} : { target: "launcher" },
        );
        return response.ok
          ? Response.json({
              mode: already ? "launcher" : "rebooting",
              process_id: boot,
            })
          : response;
      }
      if (info.role !== "launcher")
        return Response.json(
          { error: "Call launcher.enter and wait for launcher mode" },
          { status: 409 },
        );
      if (info.image_profile !== "ESPHUB1/launcher/" + args.board)
        return Response.json(
          { error: "Upgrade this older launcher with launcher.install first" },
          { status: 409 },
        );
      if (
        args.url.startsWith(artifactBase) &&
        !(await this.uploads.ready(args.url, args.kind))
      )
        return Response.json(
          {
            error:
              "Upload this device’s file first and use its matching OTA kind",
          },
          { status: 409 },
        );
      const transfer_id = crypto.randomUUID();
      const after = (await this.stream(boot, "tx").head()).last;
      if (this.active() !== socket || this.current()?.pid !== boot)
        return Response.json(
          { error: "Launcher session changed" },
          { status: 409 },
        );
      const response = await this.rpc(socket, "install", {
        ...args,
        transfer_id,
      });
      if (!response.ok) return response;
      const { data } = await response.json();
      if (!data?.accepted)
        return Response.json(
          { error: "Launcher did not accept OTA" },
          { status: 409 },
        );
      return Response.json({
        accepted: true,
        transfer_id,
        process_id: boot,
        after,
      });
    }
    return this.rpc(socket, args.op, args.args);
  }
  legacyRepl(pid) {
    const attachment = this.active()?.deserializeAttachment();
    if (typeof attachment?.legacyRepl === "boolean")
      return attachment.legacyRepl;
    const info = JSON.parse(
      this.db.exec("SELECT info FROM boots WHERE pid=?", pid).one().info,
    );
    return legacyRepl(info);
  }
  rpc(socket, op, args) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(
          Response.json(
            { error: "Device response timed out; outcome unknown" },
            { status: 504 },
          ),
        );
      }, 25000);
      this.pending.set(id, {
        socket,
        finish: (r) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(r);
        },
      });
      try {
        socket.send(JSON.stringify({ t: "req", id, op, args }));
      } catch {
        this.pending
          .get(id)
          .finish(
            Response.json(
              { error: "Connection closed; outcome unknown" },
              { status: 503 },
            ),
          );
      }
    });
  }
  async webSocketMessage(ws, raw) {
    if (ws !== this.active()) return;
    if (raw === "ping") {
      ws.send("pong");
      return;
    }
    if (typeof raw !== "string" || raw.length > 65536) {
      ws.close(1009, "Invalid frame");
      return;
    }
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      ws.close(1007, "Invalid JSON");
      return;
    }
    if (m.t === "res") {
      const p = this.pending.get(m.id);
      if (p?.socket === ws)
        p.finish(
          Response.json(
            m.ok
              ? { data: m.data }
              : { error: m.error || "Device refused operation" },
            { status: m.ok ? 200 : 409 },
          ),
        );
      return;
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      if (m.t === "hello") {
        if (
          typeof m.boot_id !== "string" ||
          !/^[0-9a-f-]{8,36}$/i.test(m.boot_id)
        ) {
          ws.close(1008, "Invalid process ID");
          return;
        }
        const pid = m.boot_id;
        this.db.exec(
          "INSERT INTO boots(pid,started,info) VALUES(?,?,?) ON CONFLICT(pid) DO UPDATE SET info=excluded.info",
          pid,
          new Date().toISOString(),
          JSON.stringify(m),
        );
        this.db.exec("UPDATE current_device SET pid=?", pid);
        ws.serializeAttachment({ pid, legacyRepl: legacyRepl(m) });
        const tx = this.stream(pid, "tx");
        await Promise.all([tx.init(), this.stream(pid, "rx").init()]);
        this.rxLast = (await this.stream(pid, "rx").head()).last;
        ws.send(JSON.stringify({ t: "ack", seq: (await tx.head()).source }));
        return;
      }
      const pid = ws.deserializeAttachment()?.pid;
      if (!pid || pid !== this.current()?.pid) return;
      if (
        m.t === "uart.poll" &&
        Number.isSafeInteger(m.after) &&
        m.after >= 0
      ) {
        if (this.legacyRepl(pid)) return;
        const stored = this.db
          .exec("SELECT rx_cursor FROM boots WHERE pid=?", pid)
          .one().rx_cursor;
        if (m.after !== stored)
          this.db.exec(
            "UPDATE boots SET rx_cursor=? WHERE pid=?",
            m.after,
            pid,
          );
        if (m.after < (this.rxLast ?? Infinity)) {
          const res = await this.stream(pid, "rx").read(m.after, 1);
          this.rxLast = res.last;
          if (res.records.length)
            ws.send(JSON.stringify({ t: "uart.input", ...res.records[0] }));
        }
      } else {
        const ack = await this.recordFrame(pid, m);
        if (ack) ws.send(JSON.stringify(ack));
      }
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
    } else if (m.t === "event" && typeof m.name === "string") {
      await this.stream(pid, "tx").append([
        {
          at: new Date().toISOString(),
          text: m.name + " " + JSON.stringify(m.data ?? {}),
        },
      ]);
    }
    return null;
  }
  webSocketClose(ws) {
    for (const x of this.pending.values())
      if (x.socket === ws)
        x.finish(
          Response.json(
            { error: "Disconnected; command outcome unknown" },
            { status: 503 },
          ),
        );
    try {
      ws.close();
    } catch {}
  }
  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}
