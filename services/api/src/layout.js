export const appAlignment = 64 * 1024;
export const sectorSize = 4096;
export const maxFlashBytes = 32 * 1024 * 1024;
export const minLittleFSBytes = 2 * 4096;
export const maxTailPartitions = 16;
export const partitionLabelPattern = /^[A-Za-z0-9._-]{1,15}$/;

const namedSubtypes = {
  ota_2: 0x12,
  ota: 0x00,
  phy: 0x01,
  nvs: 0x02,
  coredump: 0x03,
  nvs_keys: 0x04,
  efuse: 0x05,
  undefined: 0x06,
  esphttpd: 0x80,
  fat: 0x81,
  spiffs: 0x82,
  littlefs: 0x83,
};

export function parsePartitionType(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (value === 0 || value === "app") return 0;
  if (value === 1 || value === "data") return 1;
  return null;
}

export function parsePartitionSubtype(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xfe) return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (Object.hasOwn(namedSubtypes, trimmed)) return namedSubtypes[trimmed];
    if (/^0x[0-9a-f]{1,2}$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 16);
      if (parsed >= 0 && parsed <= 0xfe) return parsed;
    }
  }
  return null;
}

export function validTailPartitions(partitions, { tailOffset = null, tailSizeBytes = null } = {}) {
  if (!Array.isArray(partitions) || partitions.length < 1 || partitions.length > maxTailPartitions) {
    return false;
  }
  const seen = new Set();
  let cursor = tailOffset;
  let total = 0;
  for (let i = 0; i < partitions.length; i++) {
    const p = partitions[i];
    if (!p || typeof p !== "object" || Array.isArray(p)) return false;
    if (typeof p.label !== "string" || !partitionLabelPattern.test(p.label)) return false;
    if (seen.has(p.label)) return false;
    seen.add(p.label);
    if (i === 0) {
      if (p.label !== "app" || p.type !== 0 || p.subtype !== 0x12) return false;
      if (!Number.isSafeInteger(p.size) || p.size < appAlignment || p.size % appAlignment !== 0)
        return false;
    } else {
      if (p.type !== 1 || !Number.isInteger(p.subtype) || p.subtype < 0 || p.subtype > 0xfe)
        return false;
      if (!Number.isSafeInteger(p.size) || p.size < sectorSize || p.size % sectorSize !== 0)
        return false;
    }
    if (tailOffset !== null) {
      if (!Number.isSafeInteger(p.offset) || p.offset !== cursor) return false;
      cursor += p.size;
    }
    total += p.size;
  }
  if (total > maxFlashBytes) return false;
  if (tailSizeBytes !== null && total > tailSizeBytes) return false;
  return true;
}

export function normalizeLayout(layout) {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) return null;
  const { app_size_bytes: app, data_size_bytes: data } = layout;
  if (!Number.isSafeInteger(app) || app < appAlignment || app % appAlignment !== 0) return null;
  if (!Number.isSafeInteger(data) || data < 0 || data % sectorSize !== 0) return null;
  if (layout.partitions !== undefined) {
    const { tail_offset, tail_size_bytes, partitions } = layout;
    if (
      !Number.isSafeInteger(tail_offset) ||
      tail_offset < appAlignment ||
      tail_offset % appAlignment !== 0 ||
      !Number.isSafeInteger(tail_size_bytes) ||
      tail_size_bytes < appAlignment ||
      tail_offset + tail_size_bytes > maxFlashBytes
    )
      return null;
    if (!validTailPartitions(partitions, { tailOffset: tail_offset, tailSizeBytes: tail_size_bytes }))
      return null;
    if (partitions[0].size !== app) return null;
    const cleanPartitions = partitions.map(({ label, type, subtype, offset, size }) => ({
      label,
      type,
      subtype,
      offset,
      size,
    }));
    return {
      app_size_bytes: app,
      data_size_bytes: data,
      tail_offset,
      tail_size_bytes,
      partitions: cleanPartitions,
    };
  }
  if (data < minLittleFSBytes || app + data > maxFlashBytes) return null;
  return { app_size_bytes: app, data_size_bytes: data };
}

export function validLayout(layout) {
  return normalizeLayout(layout) !== null;
}

export function maxAppSize(layout) {
  const total = Number.isSafeInteger(layout.tail_size_bytes)
    ? layout.tail_size_bytes
    : layout.app_size_bytes + layout.data_size_bytes;
  return Math.floor((total - minLittleFSBytes) / appAlignment) * appAlignment;
}

export function layoutsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].label !== b[i].label ||
      a[i].type !== b[i].type ||
      a[i].subtype !== b[i].subtype ||
      a[i].offset !== b[i].offset ||
      a[i].size !== b[i].size
    )
      return false;
  }
  return true;
}
