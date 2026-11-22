// The OTA slot/profile is shared by MicroPython and native applications.
export function softwareInventory(current, previous) {
  const launcher = current?.role === "launcher" ? current : previous;
  const app = current?.role === "app" ? current : previous;
  const fw = app?.role === "app" ? app.fw : null;
  return {
    launcher_version:
      current?.launcher_version ||
      (launcher?.role === "launcher" && launcher.fw?.version) ||
      null,
    launcher_last_seen:
      current?.role === "app" &&
      !current.launcher_version &&
      launcher?.role === "launcher",
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
