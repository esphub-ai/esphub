// Empty LittleFS 2.1 root commit produced by lfs_format (4 KiB erase blocks,
// 128-byte programs, max file name 63). Only revision, block count and CRC
// vary. The rest of each 4 KiB block is erased by the Launcher.
const rootCommit = Uint8Array.from(
  "01000000f00ffff76c6974746c6566732fe000100100020000100000100000003f000000ffffff7ffe0300007feffc1080000000b3abd29a0ff0004c".match(/../g), (hex) => Number.parseInt(hex, 16),
);

export const appAlignment = 64 * 1024;
export const maxFlashBytes = 32 * 1024 * 1024;

export function validLayout(layout) {
  if (!layout) return false;
  const { app_size_bytes: app, data_size_bytes: data } = layout;
  return Number.isSafeInteger(app) && app >= appAlignment && app % appAlignment === 0 &&
    Number.isSafeInteger(data) && data >= 8192 && data % 4096 === 0 && app + data <= maxFlashBytes;
}

export function emptyLittleFS(size) {
  if (!Number.isSafeInteger(size) || size < 8192 || size > maxFlashBytes || size % 4096)
    throw new RangeError("Invalid LittleFS capacity");
  const bytes = new Uint8Array(256).fill(0xff);
  const view = new DataView(bytes.buffer);
  for (let block = 0; block < 2; block++) {
    const start = block * 128;
    bytes.set(rootCommit, start);
    view.setUint32(start, block + 1, true);
    view.setUint32(start + 28, size / 4096, true);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(start, start + rootCommit.length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    view.setUint32(start + rootCommit.length, crc, true);
  }
  return btoa(String.fromCharCode(...bytes));
}
