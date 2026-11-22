import { DurableObject } from "cloudflare:workers";
import { HTTPException } from "hono/http-exception";
import { installProgram } from "./programs.js";
import { Stream } from "./streams.js";
export class Device extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    this.db = ctx.storage.sql;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS boots(pid TEXT PRIMARY KEY,started TEXT,info TEXT,rx_cursor INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS current_device(id TEXT, pid TEXT); CREATE TABLE IF NOT EXISTS writes(pid TEXT,k TEXT,seq INTEGER,PRIMARY KEY(pid,k))",
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
  async fetch(req) {
    const url = new URL(req.url),
      path = url.pathname;
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
      return Response.json({
        online: !!socket && socket.deserializeAttachment()?.pid === boot,
        process_id: boot || null,
        info: row ? JSON.parse(row.info) : null,
      });
    }
    if (path === "/revoke") {
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
    if (path === "/program") {
      const { info } = this.db
        .exec("SELECT info FROM boots WHERE pid=?", boot)
        .one();
      const report = JSON.parse(info);
      if (
        report.role !== "app" ||
        (report.board && report.board !== args.board)
      )
        return Response.json(
          { error: "Start the matching ESP Hub MicroPython runtime first" },
          { status: 409 },
        );
      if (this.installing)
        return Response.json(
          { error: "A program installation is already in progress" },
          { status: 409 },
        );
      this.installing = true;
      try {
        let after;
        const receipt = await installProgram(
          args.source,
          async (op, params) => {
            if (op === "py.reset")
              after = (await this.stream(boot, "tx").head()).last;
            if (this.active() !== socket || this.current()?.pid !== boot)
              throw new HTTPException(409, {
                message: "Device session changed during installation",
              });
            const response = await this.rpc(socket, op, params);
            const body = await response.json();
            if (!response.ok)
              throw new HTTPException(response.status, { message: body.error });
            return body.data;
          },
        );
        return Response.json({
          ...receipt,
          device_id: this.current().id,
          process_id: boot,
          after,
        });
      } catch (error) {
        if (error instanceof HTTPException)
          return Response.json(
            { error: error.message },
            { status: error.status },
          );
        throw error;
      } finally {
        this.installing = false;
      }
    }
    return this.rpc(socket, args.op, args.args);
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
        ws.serializeAttachment({ pid });
        const tx = this.stream(pid, "tx");
        await Promise.all([tx.init(), this.stream(pid, "rx").init()]);
        this.rxLast = (await this.stream(pid, "rx").head()).last;
        ws.send(JSON.stringify({ t: "ack", seq: (await tx.head()).source }));
        return;
      }
      const pid = ws.deserializeAttachment()?.pid;
      if (!pid || pid !== this.current()?.pid) return;
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
        ws.send(
          JSON.stringify({
            t: "ack",
            seq: rows.at(-1)?.source_seq ?? head.source,
          }),
        );
      } else if (
        m.t === "uart.poll" &&
        Number.isSafeInteger(m.after) &&
        m.after >= 0
      ) {
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
      } else if (m.t === "event" && typeof m.name === "string") {
        await this.stream(pid, "tx").append([
          {
            at: new Date().toISOString(),
            text: m.name + " " + JSON.stringify(m.data ?? {}),
          },
        ]);
      }
    });
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
