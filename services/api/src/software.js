// The OTA slot/profile is shared by MicroPython and native applications.
export function softwareInventory(current, previous) {
  const bootloader = current?.role === "bootloader" ? current : previous;
  const app = current?.role === "app" ? current : previous;
  const fw = app?.role === "app" ? app.fw : null;
  const legacyKind = app?.micropython_version || fw?.name === "micropython" ? "micropython" : "native";
  const runtime = app?.role === "app" && app.runtime_type;
  return {
    bootloader_version:
      current?.bootloader_version ||
      (bootloader?.role === "bootloader" &&
        (bootloader.bootloader_version || bootloader.fw?.version)) ||
      null,
    bootloader_last_seen:
      current?.role === "app" &&
      !current.bootloader_version &&
      bootloader?.role === "bootloader",
    application: runtime || fw
      ? {
          process_id: app.boot_id,
          last_seen: current?.role !== "app",
          kind: runtime || legacyKind,
          runtime_version: app.runtime_version ?? fw?.version ?? app.micropython_version ?? null,
          name: fw?.name ?? null,
          version: app.runtime_version ?? fw?.version ?? null,
          micropython_version: app.micropython_version ?? null,
          sdk_version: app.sdk_version ?? null,
          esp_idf_version: fw?.idf ?? null,
        }
      : null,
  };
}
