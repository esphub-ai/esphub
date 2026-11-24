export function softwareInventory(current, previous) {
  const previousLauncher = previous?.role === "bootloader" && previous.bootloader_version;
  const app = current?.role === "app" ? current : previous;
  const runtime = app?.role === "app" && app.runtime_type;
  return {
    bootloader_version: current?.bootloader_version || previousLauncher || null,
    bootloader_last_seen: Boolean(!current?.bootloader_version && previousLauncher),
    application: runtime
      ? {
          kind: runtime,
          runtime_version: app.runtime_version ?? null,
          last_seen: current?.role !== "app",
        }
      : null,
  };
}
