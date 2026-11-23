// The OTA slot/profile is shared by MicroPython and native applications.
export function softwareInventory(current, previous) {
  const bootloader = current?.role === "bootloader" ? current : previous;
  const app = current?.role === "app" ? current : previous;
  const fw = app?.role === "app" ? app.fw : null;
  return {
    bootloader_version:
      current?.bootloader_version ||
      (bootloader?.role === "bootloader" && bootloader.fw?.version) ||
      null,
    bootloader_last_seen:
      current?.role === "app" &&
      !current.bootloader_version &&
      bootloader?.role === "bootloader",
    application: fw
      ? {
          process_id: app.boot_id,
          last_seen: current?.role !== "app",
          kind:
            app.micropython_version || fw.name === "micropython"
              ? "micropython"
              : "native",
          name: fw.name,
          version: fw.version,
          micropython_version: app.micropython_version ?? null,
          sdk_version: app.sdk_version ?? null,
          esp_idf_version: fw.idf ?? null,
        }
      : null,
  };
}
