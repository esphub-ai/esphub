// Exercise the same MQTT frames and HTTPS calls as the firmware.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
const exec = promisify(execFile);
export function simulatedDevice(site, token) {
  const args = ["-h", "127.0.0.1", "-p", process.env.TEST_MQTT_PORT];
  const csr =
    "-----BEGIN CERTIFICATE REQUEST-----\n" +
    randomUUID() +
    "\n-----END CERTIFICATE REQUEST-----";
  let device,
    sub,
    boot,
    mid = 0;
  const acks = new Map(),
    inbox = [],
    messages = [],
    httpsRequests = [];
  let lastInfo;
  async function post(path, value) {
    httpsRequests.push(path);
    const r = await fetch(site + "/backend/api/device/" + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  }
  async function send(frame) {
    const id = ++mid;
    const payload = { ...frame, mid: id, boot_id: boot, confirm: true };
    let timer;
    const done = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("No MQTT application ACK for " + frame.t)),
        12000,
      );
      acks.set(id, resolve);
    });
    try {
      const [ack] = await Promise.all([
        done,
        exec("mosquitto_pub", [
          ...args,
          "-q",
          "1",
          "-t",
          "devices/" + device + "/up",
          "-m",
          JSON.stringify({ frame: payload }),
        ]),
      ]);
      return ack;
    } finally {
      clearTimeout(timer);
      acks.delete(id);
    }
  }
  async function disconnect() {
    if (!sub) return;
    const stopped = once(sub, "exit");
    sub.kill();
    await stopped;
    sub = undefined;
    inbox.length = messages.length = 0;
  }
  async function subscribe() {
    if (!sub) {
      sub = spawn("stdbuf", [
        "-oL",
        "mosquitto_sub",
        ...args,
        "-i",
        "esphub-" + device,
        "-q",
        "1",
        "-t",
        "devices/" + device + "/wake",
        "-d",
      ]);
      const lines = createInterface({ input: sub.stdout });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("MQTT subscribe timeout")),
          5000,
        );
        lines.on("line", (line) => {
          if (line.includes("SUBACK")) {
            clearTimeout(timer);
            resolve();
          }
          if (!line.startsWith("{")) return;
          const m = JSON.parse(line);
          if (m.boot_id !== boot) return;
          if (m.command) inbox.push(m.command);
          else if (m.message) messages.push(m.message);
          else acks.get(m.mid)?.(m);
        });
        sub.on("error", reject);
      });
    }
  }
  return {
    principal: createHash("sha256").update(csr).digest("hex"),
    httpsRequests,
    get queued() {
      return inbox.length;
    },
    disconnect,
    subscribe,
    async reconnect() {
      await disconnect();
      await subscribe();
      await send({ t: "hello", ...lastInfo });
    },
    send,
    sendBestEffort(frame) {
      return exec("mosquitto_pub", [
        ...args,
        "-q",
        "0",
        "-t",
        "devices/" + device + "/up",
        "-m",
        JSON.stringify({ frame: { ...frame, mid: ++mid, boot_id: boot } }),
      ]);
    },
    close() {
      sub?.kill();
    },
    async hello(info) {
      boot = randomUUID().replaceAll("-", "");
      inbox.length = messages.length = 0;
      if (!device) device = (await post("iot/enroll", { csr })).device_id;
      await subscribe();
      lastInfo = info;
      await send({ t: "hello", ...info });
      return boot;
    },
    async nextMessage() {
      for (let i = 0; !messages.length && i < 250; ++i) await delay(20);
      assert.ok(messages.length, "Expected a message on the MQTT subscription");
      return messages.shift();
    },
    async nextCommand() {
      for (let i = 0; !inbox.length && i < 250; ++i) await delay(20);
      assert.ok(inbox.length, "Expected a command on the MQTT subscription");
      return inbox.shift();
    },
  };
}
