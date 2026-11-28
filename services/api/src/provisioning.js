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
    ? "The board starts in the EspHub Bootloader and connects. Confirm online=true and info.role=bootloader with devices_get. Once online, tell the user wireless OTA is ready and they can unplug the USB data cable from the computer (the board only needs power), then call bootloader_exit or power-cycle the board to start the flashed project app and verify the new online app session."
    : `The board starts in the EspHub Bootloader (Launcher) and attempts to join Wi-Fi. Check devices_get for online=true and info.role=bootloader:
- If online: tell the user the board is connected and ready for wireless OTA, and remind them they can unplug the USB data cable from the computer (power only is enough). Call projects_search for ${board.id} to suggest a few fun published starter projects for this board, and ask which project (via projects_get + ota_install) or custom binary (via ota_prepare_upload + ota_install) they want to install over OTA.
- If still offline and USB is connected: open the USB serial port at 115200 baud and send newline-terminated \`EH-WIFI {"op":"wifi.scan"}\` to list the 2.4 GHz networks the board can actually see. Show those SSIDs to the user, ask which network to join and its password, then send \`EH-WIFI {"op":"wifi.join","ssid":"...","password":"...","hidden":false}\` and poll \`EH-WIFI {"op":"wifi.status"}\` and devices_get until online=true.
- If still offline and USB is unplugged: call wifi_ble_credential to get the TLS 1.3 PSK (identity "wifi"), scan BLE for EspHub service a2eefb31-6c36-481f-ae10-7724fa912101 (characteristic a2eefb31-6c36-481f-ae10-7724fa912102), and send the same \`{"op":"wifi.scan"}\`, \`{"op":"wifi.join",...}\`, and \`{"op":"wifi.status"}\` JSON lines over TLS-PSK to let the user pick a visible network and enter its password.
Once the board comes online, continue directly to the online OTA step above.`;
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
