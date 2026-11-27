// Pure-JS ESP-IDF NVS v2 partition image generator and parser.
// Matches components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py (version 2).
import { fail } from "./auth.js";

export const PAGE_SIZE = 4096;
export const defaultNvsOffset = 0x9000;
export const defaultNvsSize = 0x6000;
const ENTRY_SIZE = 32;
const ENTRIES_PER_PAGE = 126;
const PAGE_STATE_EMPTY = 0xffffffff;
const PAGE_STATE_ACTIVE = 0xfffffffe;
const PAGE_STATE_FULL = 0xfffffffc;
const NVS_VERSION_2 = 0xfe;
const TYPE_U8 = 0x01;
const TYPE_STR = 0x21;
const MAX_KEY_BYTES = 15;
const MAX_NVS_SIZE = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c >>> 0;
}

// Equivalent to esp_rom_crc32_le(UINT32_MAX, bytes, len) / zlib.crc32(bytes, 0xFFFFFFFF).
export function espCrc32(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++)
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (~crc) >>> 0;
}

function entryHeaderCrc(entry) {
  const input = new Uint8Array(28);
  input.set(entry.subarray(0, 4), 0);
  input.set(entry.subarray(8, 32), 4);
  return espCrc32(input);
}

function writeKey(entry, key) {
  const keyBytes = encoder.encode(key);
  if (!keyBytes.length || keyBytes.length > MAX_KEY_BYTES || key.includes("\0"))
    throw new Error(`Invalid NVS key: ${key}`);
  entry.fill(0, 8, 24);
  entry.set(keyBytes, 8);
}

function initPageHeader(page, seq, state) {
  const view = new DataView(page.buffer, page.byteOffset, PAGE_SIZE);
  view.setUint32(0, state, true);
  view.setUint32(4, seq, true);
  page[8] = NVS_VERSION_2;
  page.fill(0xff, 9, 28);
  view.setUint32(28, espCrc32(page.subarray(4, 28)), true);
}

function markWritten(page, startIndex, span) {
  for (let i = startIndex; i < startIndex + span; i++) {
    const byteOffset = 32 + (i >> 2);
    const bitOffset = (i & 3) * 2;
    page[byteOffset] &= ~(1 << bitOffset);
  }
}

export function buildNvs(namespaces, size = defaultNvsSize) {
  if (
    !Number.isSafeInteger(size) ||
    size < 3 * PAGE_SIZE ||
    size > MAX_NVS_SIZE ||
    size % PAGE_SIZE !== 0
  )
    throw new Error(`Invalid NVS partition size: ${size}`);

  const totalPages = size / PAGE_SIZE;
  const usablePages = totalPages - 1; // Reserve at least one empty spare page.
  const image = new Uint8Array(size);
  image.fill(0xff);

  let pageIdx = 0;
  let entryIdx = 0;
  let page = image.subarray(0, PAGE_SIZE);
  initPageHeader(page, 0, PAGE_STATE_ACTIVE);

  const ensureSpace = (span) => {
    if (span > ENTRIES_PER_PAGE) throw new Error("NVS entry exceeds page capacity");
    if (entryIdx + span <= ENTRIES_PER_PAGE) return;
    new DataView(page.buffer, page.byteOffset, PAGE_SIZE).setUint32(
      0,
      PAGE_STATE_FULL,
      true,
    );
    pageIdx++;
    if (pageIdx >= usablePages) throw new Error("NVS partition full");
    page = image.subarray(pageIdx * PAGE_SIZE, (pageIdx + 1) * PAGE_SIZE);
    initPageHeader(page, pageIdx, PAGE_STATE_ACTIVE);
    entryIdx = 0;
  };

  const writeU8 = (nsIndex, key, value) => {
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new Error(`Invalid NVS u8 value for ${key}`);
    ensureSpace(1);
    const offset = 64 + entryIdx * ENTRY_SIZE;
    const entry = page.subarray(offset, offset + ENTRY_SIZE);
    entry.fill(0xff);
    entry[0] = nsIndex;
    entry[1] = TYPE_U8;
    entry[2] = 1;
    entry[3] = 0xff;
    writeKey(entry, key);
    entry[24] = value;
    new DataView(entry.buffer, entry.byteOffset, ENTRY_SIZE).setUint32(
      4,
      entryHeaderCrc(entry),
      true,
    );
    markWritten(page, entryIdx, 1);
    entryIdx += 1;
  };

  const writeStr = (nsIndex, key, value) => {
    if (typeof value !== "string" || value.includes("\0"))
      throw new Error(`Invalid NVS string value for ${key}`);
    const raw = encoder.encode(value);
    const data = new Uint8Array(raw.length + 1);
    data.set(raw, 0);
    data[raw.length] = 0;
    const dataEntries = Math.ceil(data.length / ENTRY_SIZE);
    const span = 1 + dataEntries;
    if (data.length > 0xffff) throw new Error(`NVS string too long for ${key}`);
    ensureSpace(span);
    const offset = 64 + entryIdx * ENTRY_SIZE;
    const entry = page.subarray(offset, offset + ENTRY_SIZE);
    entry.fill(0xff);
    entry[0] = nsIndex;
    entry[1] = TYPE_STR;
    entry[2] = span;
    entry[3] = 0xff;
    writeKey(entry, key);
    const view = new DataView(entry.buffer, entry.byteOffset, ENTRY_SIZE);
    view.setUint16(24, data.length, true);
    view.setUint16(26, 0xffff, true);
    view.setUint32(28, espCrc32(data), true);
    view.setUint32(4, entryHeaderCrc(entry), true);
    const dataStart = offset + ENTRY_SIZE;
    page.fill(0xff, dataStart, dataStart + dataEntries * ENTRY_SIZE);
    page.set(data, dataStart);
    markWritten(page, entryIdx, span);
    entryIdx += span;
  };

  let nextNsId = 1;
  for (const [nsName, entries] of Object.entries(namespaces)) {
    const nsId = nextNsId++;
    if (nsId > 254) throw new Error("Too many NVS namespaces");
    writeU8(0, nsName, nsId);
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) continue;
      if (typeof value === "number") writeU8(nsId, key, value);
      else if (typeof value === "string") writeStr(nsId, key, value);
      else throw new Error(`Unsupported NVS value type for ${nsName}/${key}`);
    }
  }
  return image;
}

export function parseNvs(bytes) {
  const image = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (image.length < 3 * PAGE_SIZE || image.length % PAGE_SIZE !== 0)
    throw new Error("Invalid NVS partition size");
  const nsNames = new Map();
  const result = {};
  const pages = image.length / PAGE_SIZE;

  for (let p = 0; p < pages; p++) {
    const page = image.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
    const view = new DataView(page.buffer, page.byteOffset, PAGE_SIZE);
    const state = view.getUint32(0, true);
    if (state === PAGE_STATE_EMPTY) continue;
    if (state !== PAGE_STATE_ACTIVE && state !== PAGE_STATE_FULL)
      throw new Error(`Invalid NVS page state: 0x${state.toString(16)}`);
    if (page[8] !== NVS_VERSION_2)
      throw new Error(`Unsupported NVS version: 0x${page[8].toString(16)}`);
    const expectedHeaderCrc = espCrc32(page.subarray(4, 28));
    if (view.getUint32(28, true) !== expectedHeaderCrc)
      throw new Error(`NVS page ${p} header CRC mismatch`);

    let i = 0;
    while (i < ENTRIES_PER_PAGE) {
      const bits = (page[32 + (i >> 2)] >> ((i & 3) * 2)) & 0x3;
      if (bits !== 0b10) {
        i++;
        continue;
      }
      const offset = 64 + i * ENTRY_SIZE;
      const entry = page.subarray(offset, offset + ENTRY_SIZE);
      const ev = new DataView(entry.buffer, entry.byteOffset, ENTRY_SIZE);
      const nsIndex = entry[0];
      const type = entry[1];
      const span = entry[2];
      if (span < 1 || i + span > ENTRIES_PER_PAGE)
        throw new Error(`Invalid NVS entry span at page ${p} entry ${i}`);
      if (ev.getUint32(4, true) !== entryHeaderCrc(entry))
        throw new Error(`NVS entry CRC mismatch at page ${p} entry ${i}`);
      const keyRaw = entry.subarray(8, 24);
      const nul = keyRaw.indexOf(0);
      if (nul <= 0) throw new Error(`Invalid NVS key at page ${p} entry ${i}`);
      const key = decoder.decode(keyRaw.subarray(0, nul));

      if (nsIndex === 0 && type === TYPE_U8) {
        const nsId = entry[24];
        nsNames.set(nsId, key);
        result[key] ??= {};
      } else {
        const ns = nsNames.get(nsIndex);
        if (!ns) throw new Error(`Unknown NVS namespace index ${nsIndex}`);
        if (type === TYPE_U8) {
          result[ns][key] = entry[24];
        } else if (type === TYPE_STR) {
          const len = ev.getUint16(24, true);
          const dataCrc = ev.getUint32(28, true);
          const dataStart = offset + ENTRY_SIZE;
          const dataBytes = page.subarray(dataStart, dataStart + len);
          if (len === 0 || dataBytes[len - 1] !== 0)
            throw new Error(`Invalid NVS string termination for ${ns}/${key}`);
          if (espCrc32(dataBytes) !== dataCrc)
            throw new Error(`NVS string CRC mismatch for ${ns}/${key}`);
          result[ns][key] = decoder.decode(dataBytes.subarray(0, len - 1));
        } else {
          throw new Error(`Unsupported NVS entry type 0x${type.toString(16)}`);
        }
      }
      i += span;
    }
  }
  return result;
}

export function parseWifi(wifi) {
  if (wifi === undefined || wifi === null) return null;
  if (typeof wifi !== "object" || Array.isArray(wifi))
    fail(400, "Invalid wifi configuration");
  for (const key of Object.keys(wifi))
    if (!["ssid", "password", "hidden"].includes(key))
      fail(400, "Unexpected wifi." + key);
  if (
    typeof wifi.ssid !== "string" ||
    !wifi.ssid.length ||
    wifi.ssid.includes("\0") ||
    encoder.encode(wifi.ssid).length > 32
  )
    fail(400, "Invalid ssid");
  const password = wifi.password ?? "";
  if (
    typeof password !== "string" ||
    password.includes("\0") ||
    encoder.encode(password).length > 63
  )
    fail(400, "Invalid password");
  if (wifi.hidden !== undefined && typeof wifi.hidden !== "boolean")
    fail(400, "Invalid hidden");
  return {
    s: wifi.ssid,
    p: password,
    ...(wifi.hidden ? { h: true } : {}),
  };
}

export function buildDeviceNvs({
  hub = "api.esphub.ai",
  token,
  bleSecret,
  wifi,
  size = defaultNvsSize,
}) {
  const eh = {
    hold: 1,
    hub,
    tok: token,
    ble_key: bleSecret,
    ...(wifi ? { wifis: JSON.stringify([wifi]) } : {}),
  };
  return buildNvs({ eh }, size);
}
