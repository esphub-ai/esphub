import { ESPLoader, Transport } from "esptool-js";
import { strFromU8, unzipSync } from "fflate";
import SparkMD5 from "spark-md5";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function release(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw Error("The official setup kit is unavailable for this board.");
  return response;
}

export async function flashSetupKit(port, board, profile, progress) {
  const base = "/setup-firmware/" + board;
  progress("Downloading official setup kit…");
  const manifest = await (await release(base + "/setup-manifest")).json();
  if (
    manifest.board !== board ||
    manifest.chip !== profile.chip ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version)
  )
    throw Error("The setup kit does not match the selected board.");
  if (manifest.usb_wifi_setup !== true)
    throw Error(
      "The published setup kit does not support USB Wi-Fi yet. Use a bootloader built with USB Wi-Fi setup.",
    );
  const tag = `firmware-setup-${board}-v${manifest.version}`;
  const archive = await (
    await release(base + "/setup?tag=" + tag)
  ).arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", archive));
  const sha256 = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (sha256 !== manifest.sha256)
    throw Error("Setup kit checksum did not match.");
  const files = unzipSync(new Uint8Array(archive));
  const [settings, ...images] = strFromU8(files.flash_args)
    .trim()
    .split(/\r?\n/);
  const args = settings.trim().split(/\s+/);
  const setting = (key) =>
    args.includes(key) ? args[args.indexOf(key) + 1] : "keep";
  const fileArray = images.map((line) => {
    const match = /^\s*(0x[\da-f]+|\d+)\s+([\w.-]+)\s*$/i.exec(line);
    if (!match || !Object.hasOwn(files, match[2]) || !files[match[2]].length)
      throw Error("The setup kit contains invalid flash arguments.");
    return { address: Number(match[1]), data: files[match[2]] };
  });
  if (!fileArray.length) throw Error("The setup kit contains no firmware.");
  const transport = new Transport(port);
  const loader = new ESPLoader({ transport, baudrate: 115200 });
  progress("Checking the chip and flash capacity…");
  try {
    await loader.main("no_reset");
    if (
      loader.chip.CHIP_NAME.toLowerCase().replaceAll("-", "") !==
        profile.chip ||
      (await loader.detectFlashSize()) !== profile.flash_mb + "MB"
    )
      throw Error(
        "The USB chip or flash capacity does not match the selected board.",
      );
    if (!loader.IS_STUB)
      throw Error(
        "This device could not start the flash stub required for first-time installation.",
      );
    const mac = (await loader.chip.readMac(loader)).toLowerCase();
    await loader.writeFlash({
      fileArray,
      flashSize: profile.flash_mb + "MB",
      flashMode: setting("--flash_mode"),
      flashFreq: setting("--flash_freq"),
      eraseAll: true,
      compress: true,
      calculateMD5Hash: (data) =>
        SparkMD5.ArrayBuffer.hash(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        ),
      reportProgress: (index, written, total) =>
        progress(
          `Writing image ${index + 1} of ${fileArray.length} (${Math.floor((100 * written) / total)}%)…`,
        ),
    });
    return mac;
  } finally {
    if (port.readable || port.writable) await transport.disconnect();
  }
}

export async function openUsb(port) {
  await port.open({ baudRate: 115200 });
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  const decoder = new TextDecoder();
  let response = "";
  let closing;
  const close = () =>
    (closing ??= (async () => {
      await Promise.allSettled([reader.cancel(), writer.abort()]);
      reader.releaseLock();
      writer.releaseLock();
      await port.close().catch(() => {});
    })());

  return {
    close,
    get closed() {
      return Boolean(closing);
    },
    async request(command, payload, match, timeout = 5000) {
      if (closing) throw Error("Reconnect the bootloader USB port.");
      let timer;
      const exchange = async () => {
        await writer.write(
          new TextEncoder().encode(
            "\n" + command + " " + JSON.stringify(payload) + "\n",
          ),
        );
        for (;;) {
          const { value, done } = await reader.read();
          if (done)
            throw Error(
              "The device disconnected. Reconnect the bootloader USB port.",
            );
          response += decoder.decode(value, { stream: true });
          const lines = response.split("\n");
          response = lines.pop();
          for (const line of lines) {
            const result = match(line.trim());
            if (result !== undefined) return result;
          }
          if (response.length > 16384) response = "";
        }
      };
      try {
        return await Promise.race([
          exchange(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Error(
                    "No USB response. Check that the board is running an ESPHub Bootloader with USB Wi-Fi setup.",
                  ),
                ),
              timeout,
            );
          }),
        ]);
      } catch (error) {
        await close();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function deviceWifi(port, op, fields) {
  const result = await port.request(
    "OKL-WIFI",
    { op, ...fields },
    (line) => {
      if (!line.startsWith("OKL-WIFI ")) return;
      const reply = JSON.parse(line.slice(9));
      if (!reply.op || reply.op === op) return reply;
    },
    op === "wifi.scan" ? 45000 : 5000,
  );
  if (result.error) throw Error(result.error);
  return result;
}

export function writeRegistration(port, { hub, token, ble_secret }) {
  return port.request("OKL-PROVISION", { hub, token, ble_secret }, (line) => {
    if (line.startsWith("OKL-PROVISION-ERR"))
      throw Error("The device rejected its registration.");
    if (line.startsWith("OKL-PROVISION-OK ")) return JSON.parse(line.slice(17));
  });
}

export async function waitForOnline(port, op, deviceId, ssid, progress) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const local = await deviceWifi(port, "wifi.status");
    if (local.state === "failed")
      throw Error(
        "The device could not join this network. Check the password and try again.",
      );
    if (local.state === "saved" && local.connected === ssid) {
      progress("Waiting for ESPHub to confirm the device is online…");
      const device = await op("devices.get", { device_id: deviceId });
      if (device.online && device.process_id) return device;
    } else {
      progress("Connecting to Wi-Fi…");
    }
    await delay(1500);
  }
  throw Error(
    "ESPHub has not confirmed the device is online. Check Wi-Fi and try again.",
  );
}
