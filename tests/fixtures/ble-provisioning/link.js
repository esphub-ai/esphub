// An ordered byte stream stands in for BLE. Both sides use real TLS 1.3.
import { Duplex } from "node:stream";
import { createInterface } from "node:readline";
import tls from "node:tls";
import { once } from "node:events";
import { recognizeBeacon } from "./protocol.js";

const tlsOptions = {
  minVersion: "TLSv1.3",
  maxVersion: "TLSv1.3",
  ciphers: "TLS_AES_128_GCM_SHA256",
};

function link() {
  const wire = [];
  function endpoint() {
    return new Duplex({
      read() {},
      write(bytes, encoding, done) {
        wire.push(Buffer.from(bytes));
        for (let offset = 0; offset < bytes.length; offset += 20) {
          this.peer.push(Buffer.from(bytes.subarray(offset, offset + 20)));
        }
        done();
      },
      final(done) {
        this.peer.push(null);
        done();
      },
    });
  }
  const host = endpoint(),
    device = endpoint();
  host.peer = device;
  device.peer = host;
  return { host, device, wire };
}

export async function connect(board, credential) {
  const { beacon, psk } = credential;
  const devicePsk = recognizeBeacon(board.keys.secret, beacon);
  if (!devicePsk) throw Error("unknown beacon");

  const { host, device, wire } = link();
  // A new context per link: no shared session tickets, resumption or early data.
  const server = tls.createServer({
    ...tlsOptions,
    pskCallback: (_, identity) => (identity === "wifi" ? devicePsk : null),
  });
  let peer;
  server.on("secureConnection", (socket) => {
    peer = socket;
    const requests = createInterface({ input: socket });
    requests.on("line", (line) => {
      const request = JSON.parse(line);
      board.requests++;
      let reply;
      if (request.op === "wifi.scan") {
        reply = { ssids: [...board.networks.keys()] };
      } else if (
        request.op === "wifi.join" &&
        board.networks.has(request.ssid) &&
        board.networks.get(request.ssid) === request.password
      ) {
        board.connected = request.ssid;
        reply = { connected: board.connected };
      } else {
        reply = { error: "join failed" };
      }
      socket.write(JSON.stringify(reply) + "\n");
    });
  });
  server.emit("connection", device);
  const client = tls.connect({
    ...tlsOptions,
    socket: host,
    pskCallback: () => ({ identity: "wifi", psk }),
  });
  const close = () => {
    client.destroy();
    peer?.destroy();
    device.destroy();
    host.destroy();
  };
  try {
    await once(client, "secureConnect");
  } catch (error) {
    close();
    throw error;
  }
  const lines = createInterface({ input: client })[Symbol.asyncIterator]();
  return {
    protocol: client.getProtocol(),
    wire,
    close,
    async request(message) {
      client.write(JSON.stringify(message) + "\n");
      const { value, done } = await lines.next();
      if (done) throw Error("session closed");
      return JSON.parse(value);
    },
  };
}
