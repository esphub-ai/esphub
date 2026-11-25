// Use a real, loopback-only MQTT broker. Emulate the AWS control/data API and
// the broker rule's trusted topic/principal projection for the Worker E2E.
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
export async function startBroker(site, port) {
  const secret = randomBytes(32).toString("hex"),
    principals = new Map();
  const args = ["-h", "127.0.0.1", "-p", String(port)];
  const broker = spawn("mosquitto", ["-v", "-p", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const connections = new Map();
  createInterface({ input: broker.stderr }).on("line", (line) => {
    const joined = line.match(/New client connected .* as esphub-([a-f0-9-]+)/);
    const left = line.match(/Client esphub-([a-f0-9-]+) disconnected/);
    if (joined) connections.set(joined[1], Date.now());
    if (left) connections.delete(left[1]);
  });
  let relay;
  const http = createServer(async (req, res) => {
    try {
      if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 "))
        throw Error("Expected SigV4");
      const path = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const text = Buffer.concat(chunks).toString();
      const body = text ? JSON.parse(text) : {};
      let result = {};
      if (path === "/certificates") {
        result = {
          certificatePem: "fixture-cert",
          certificateId: createHash("sha256")
            .update(body.certificateSigningRequest)
            .digest("hex"),
        };
      } else if (/^\/things\/esphub-.*\/principals$/.test(path)) {
        principals.set(
          path.split("/")[2].slice(7),
          req.headers["x-amzn-principal"].split("/").pop(),
        );
      } else if (path.startsWith("/topics/")) {
        await exec("mosquitto_pub", [
          ...args,
          "-q",
          new URL(req.url, "http://localhost").searchParams.get("qos") ?? "0",
          "-t",
          path.slice(8),
          "-m",
          text,
        ]);
      } else if (path.startsWith("/connections/esphub-")) {
        result = {
          connectedSince: connections.get(
            path.slice("/connections/esphub-".length),
          ),
          connected: connections.has(path.slice("/connections/esphub-".length)),
        };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500);
      res.end(err.message);
    }
  });
  try {
    for (let i = 0; ; i++) {
      try {
        await exec("mosquitto_pub", [...args, "-t", "fixture/ready", "-n"]);
        break;
      } catch (e) {
        if (i >= 40) throw e;
        await delay(50);
      }
    }
    relay = spawn("mosquitto_sub", [
      ...args,
      "-q",
      "1",
      "-t",
      "devices/+/up",
      "-F",
      "%t\t%p",
    ]);
    createInterface({ input: relay.stdout }).on("line", async (line) => {
      const split = line.indexOf("\t");
      const device = line.slice(0, split).split("/")[1];
      try {
        const { frame } = JSON.parse(line.slice(split + 1));
        const response = await fetch(site + "/backend/internal/iot/uplink", {
          method: "POST",
          headers: {
            authorization: "Bearer " + secret,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            device,
            principal: principals.get(device),
            frame,
          }),
        });
        if (!response.ok) console.error("Fixture relay HTTP", response.status);
      } catch (e) {
        console.error("Fixture relay", e.message);
      }
    });
    await new Promise((resolve, reject) =>
      http.once("error", reject).listen(0, "127.0.0.1", resolve),
    );
    return {
      secret,
      endpoint: "http://127.0.0.1:" + http.address().port,
      close() {
        relay.kill();
        broker.kill();
        http.close();
      },
    };
  } catch (e) {
    relay?.kill();
    broker.kill();
    http.close();
    throw e;
  }
}
