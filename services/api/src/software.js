export function softwareInventory(current, previous) {
  const previousLauncher = previous?.role === "bootloader" && previous.bootloader_version;
  const app = current?.role === "app" ? current : previous;
  return {
    bootloader_version: current?.bootloader_version || previousLauncher || null,
    bootloader_last_seen: Boolean(!current?.bootloader_version && previousLauncher),
    application: app?.role === "app" && app.fw ? {
      name: app.fw.name,
      version: app.fw.version,
      sdk_version: app.sdk_version,
      last_seen: current?.role !== "app",
    } : null,
  };
}
