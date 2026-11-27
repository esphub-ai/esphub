export const appAlignment = 64 * 1024;
export const maxFlashBytes = 32 * 1024 * 1024;
export const minLittleFSBytes = 2 * 4096;

export function maxAppSize({ app_size_bytes, data_size_bytes }) {
  return Math.floor((app_size_bytes + data_size_bytes - minLittleFSBytes) / appAlignment) * appAlignment;
}

export function validLayout(layout) {
  if (!layout) return false;
  const { app_size_bytes: app, data_size_bytes: data } = layout;
  return Number.isSafeInteger(app) && app >= appAlignment && app % appAlignment === 0 &&
    Number.isSafeInteger(data) && data >= minLittleFSBytes && data % 4096 === 0 && app + data <= maxFlashBytes;
}
