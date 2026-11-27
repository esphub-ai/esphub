export const reconnectGuidance =
  "Some physical devices may stay offline after a reboot or a switch to the bootloader. Record devices_get process_id before the transition. Allow time for Wi-Fi to reconnect, then check for online=true, a new process_id and the expected info.role (bootloader or app). Offline boot details describe the last reported session. If the device stays offline and no firmware write is in progress, ask the user to power it off and on, then check again. It may return to the app. Confirm bootloader mode before starting OTA.";

// Shell instructions for a first install with esptool. The private NVS image carries the
// device credentials and, when supplied, the Wi-Fi network.
export function provisioning(board, flash, { wifi, hasApp = false } = {}) {
  const identify = `Identify the USB board. If the port or model is ambiguous, ask the user. Check the physical model as well as the ${board.soc} chip. Proceed with the registered ${board.model}.`;
  const network = wifi
    ? "The private NVS image already contains the Wi-Fi network the user gave you."
    : "This NVS image has no Wi-Fi network, so the board cannot come online after flashing. Ask the user for the Wi-Fi SSID and password, delete this registration with devices_delete and call devices_create again with wifi before flashing.";
  const download = [
    "Install esptool with `pip install esptool`; ESP-IDF is not needed.",
    "Download every entry in flash.files into one directory under its name: `curl -fsSL -o <name> <url>`.",
    "For nvs.bin also pass its headers (`-H 'Authorization: …'`) and download it before its expires_at.",
    "Verify each file with `shasum -a 256 <name>` against its sha256 and stop on any mismatch.",
  ].join(" ");
  const write = `Put the board in ROM download mode if needed, then run, with the board's serial port in place of PORT: \`${flash.command}\`. This erases all flash. Back up any device data first.`;
  const nextStep = hasApp
    ? "The board starts in the EspHub Bootloader and connects. Confirm online=true with devices_get, then call bootloader_exit or power-cycle the board to start the flashed project app and verify the new online app session."
    : "The board starts in the EspHub Bootloader and connects. Confirm online=true and info.role=bootloader with devices_get. No application is flashed yet; use projects_search and projects_get to pick a project download URL (or upload a custom binary with ota_prepare_upload) and install it with ota_install.";
  return {
    prompt: [
      identify,
      network,
      download,
      write,
      "Keep the NVS download credential and nvs.bin private and delete nvs.bin after flashing.",
      nextStep,
      reconnectGuidance,
    ].join("\n"),
  };
}
