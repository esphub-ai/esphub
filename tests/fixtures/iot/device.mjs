// Exercise the same MQTT frames and HTTPS calls as the firmware.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
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
  const acks = new Map();
  async function post(path, value) {
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
  return {
    get id() {
      return device;
    },
    get pid() {
      return boot;
    },
    principal: createHash("sha256").update(csr).digest("hex"),
    post,
    send,
    close() {
      sub?.kill();
    },
    async hello(info) {
      boot = randomUUID().replaceAll("-", "");
      const grant = await post("iot/enroll", { csr, boot_id: boot });
      device = grant.device_id;
      if (!sub) {
        sub = spawn("stdbuf", [
          "-oL",
          "mosquitto_sub",
          ...args,
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
            if (m.boot_id === boot) acks.get(m.mid)?.(m);
          });
          sub.on("error", reject);
        });
      }
      await send({ t: "hello", proto: 2, ...info });
      return boot;
    },
    async pull() {
      return (await post("iot/pull", { boot_id: boot })).commands;
    },
  };
}
