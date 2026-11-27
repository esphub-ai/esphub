import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeviceNvs,
  buildNvs,
  defaultNvsSize,
  espCrc32,
  PAGE_SIZE,
  parseNvs,
  parseWifi,
} from "../services/api/src/nvs.js";

test("NVS CRC32 matches ESP-IDF esp_rom_crc32_le(UINT32_MAX, ...)", () => {
  assert.equal(espCrc32(new Uint8Array(0)), 0xffffffff);
  assert.equal(espCrc32(new TextEncoder().encode("hello")), 0x0fcdae64);
});

test("buildDeviceNvs produces a valid ESP-IDF NVS v2 image with device and Wi-Fi credentials", () => {
  const secret = "eh_dev_" + "A".repeat(43);
  const bleSecret = "ab".repeat(32);
  const wifi = parseWifi({
    ssid: 'Cafe, "Guest" 2.4G',
    password: 'p@ss,word"with\\quotes',
    hidden: true,
  });
  const image = buildDeviceNvs({
    token: secret,
    bleSecret,
    wifi,
  });
  assert.equal(image.byteLength, defaultNvsSize);
  // Last page remains empty as ESP-IDF NVS spare page.
  assert.ok(image.subarray(image.byteLength - PAGE_SIZE).every((b) => b === 0xff));

  const parsed = parseNvs(image);
  assert.deepEqual(parsed, {
    eh: {
      hold: 1,
      hub: "api.esphub.ai",
      tok: secret,
      ble_key: bleSecret,
      wifis: JSON.stringify([
        { s: 'Cafe, "Guest" 2.4G', p: 'p@ss,word"with\\quotes', h: true },
      ]),
    },
  });
});

test("buildDeviceNvs writes only the keys the firmware reads", () => {
  const secret = "eh_dev_" + "B".repeat(43);
  const bleSecret = "cd".repeat(32);
  const parsed = parseNvs(buildDeviceNvs({ token: secret, bleSecret }));
  assert.deepEqual(parsed, { eh: { hold: 1, hub: "api.esphub.ai", tok: secret, ble_key: bleSecret } });
});

test("buildNvs spills across pages when entries exceed a single page", () => {
  const entries = {};
  for (let i = 0; i < 40; i++) entries[`k${i}`] = "v".repeat(120);
  const image = buildNvs({ eh: entries }, 0x6000);
  const parsed = parseNvs(image);
  assert.equal(Object.keys(parsed.eh).length, 40);
  assert.equal(parsed.eh.k0, "v".repeat(120));
  assert.equal(parsed.eh.k39, "v".repeat(120));
});

test("parseNvs detects corrupted CRC", () => {
  const image = buildDeviceNvs({
    token: "eh_dev_" + "C".repeat(43),
    bleSecret: "ef".repeat(32),
  });
  image[64 + 24] ^= 0x01;
  assert.throws(() => parseNvs(image), /CRC mismatch/);
});

test("parseWifi validates SSID, password, and hidden flag", () => {
  assert.equal(parseWifi(undefined), null);
  assert.equal(parseWifi(null), null);
  assert.deepEqual(parseWifi({ ssid: "OpenNet" }), { s: "OpenNet", p: "" });
  assert.deepEqual(parseWifi({ ssid: "Home", password: "secret", hidden: false }), {
    s: "Home",
    p: "secret",
  });
  for (const bad of [
    "string",
    [],
    {},
    { ssid: "" },
    { ssid: "a".repeat(33) },
    { ssid: "bad\0ssid" },
    { ssid: "ok", password: "p".repeat(64) },
    { ssid: "ok", password: "bad\0pass" },
    { ssid: "ok", hidden: "yes" },
    { ssid: "ok", extra: 1 },
  ])
    assert.throws(() => parseWifi(bad));
});
