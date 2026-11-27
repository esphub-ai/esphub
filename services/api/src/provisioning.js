import { releaseUrl } from "../../../shared/identity.js";

export const reconnectGuidance =
  "Some physical devices may stay offline after a reboot or a switch to the bootloader. Record devices_get process_id before the transition. Allow time for Wi-Fi to reconnect, then check for online=true, a new process_id and the expected info.role (bootloader or app). Offline boot details describe the last reported session. If the device stays offline and no firmware write is in progress, ask the user to power it off and on, then check again. It may return to the app. Confirm bootloader mode before starting OTA.";

export function provisioning(profile, tag, example) {
  const board = profile.id;
  const identify = `Identify the USB board. If the port or model is ambiguous, ask the user. Check the physical model as well as the ${profile.chip} chip. Proceed with the registered ${profile.model}.`;
  const usb =
    "Download the private device NVS image from nvs.url using nvs.headers before nvs.expires_at, verify its sha256, and flash it to nvs.offset alongside the setup kit (replacing board-nvs.bin). Keep the NVS download credential and image private and delete the local file after flashing. For first-time setup with Wi-Fi credentials or to replace lost credentials for an existing device ID, use the EspHub setup API.";
  const wifi =
    "On the Mac, pass wifi_ble_credential to tools/ble-wifi/macos.py as private JSON on stdin. Keep the board in EspHub Bootloader mode for the BLE connection. Select a listed network or enter a hidden SSID, then enter its password locally.";
  const flashKit =
    "Read setup_manifest and match its board to the device. Download the ZIP over HTTPS from its download_url, then flash over USB using INSTALL.txt, flash_args, and the private device NVS image at nvs.offset. First-time installation erases flash. Back up any device data before flashing.";
  return {
    setup_manifest: releaseUrl(board, "setup-manifest", tag),
    setup_example: example,
    prompt: [
      identify, flashKit, usb, wifi, reconnectGuidance,
      "Exit Bootloader mode and confirm a new online app session. Compare the reported firmware version with the setup manifest. Observe the example behavior, then use its pinned source_url, entrypoint and build_guide_url for development.",
    ].join("\n"),
  };
}
