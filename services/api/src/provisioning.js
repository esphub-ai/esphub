import boards from "../../../shared/boards.generated.json" with { type: "json" };

export const reconnectGuidance =
  "Some physical devices may stay offline after a reboot or a switch to the bootloader. Record devices.get process_id before the transition. Allow time for Wi-Fi to reconnect, then check for online=true, a new process_id and the expected info.role (bootloader or app). Offline boot details describe the last reported session. If the device stays offline and no firmware write is in progress, ask the user to power it off and on, then check again. It may return to the app. Confirm bootloader mode before starting OTA.";

export function provisioning(board) {
  const base = `https://api.esphub.ai/releases/${board}/`;
  const profile = boards[board];
  const identify = `Identify the USB board. If the port or model is ambiguous, ask the user. Check the physical model as well as the ${profile.chip} chip. Proceed with the registered ${profile.model}.`;
  const usb =
    'Send OKL-PROVISION {"hub":"api.esphub.ai","token":"<token>","ble_secret":"<ble_secret>"} with a newline over USB at 115200. Use the plain hostname and credentials returned at registration. Wait for OKL-PROVISION-OK. Keep the response private.';
  const wifi =
    "On the Mac, pass wifi.ble_credential to tools/ble-wifi/macos.py as private JSON on stdin. Keep the board in EspHub Bootloader mode for the BLE connection. Select a listed network or enter a hidden SSID, then enter its password locally.";
  if (profile.preview) {
    return {
      board_setup_guide_url: `https://github.com/okou-ai/esphub/blob/main/${profile.directory}/README.md#bootloader-only-registration`,
      prompt: [
        identify,
        "Use an already prepared board with the matching EspHub Bootloader and board identity in NVS. Follow the board source guide if it is not initialized. This preview board has no full setup kit or MicroPython Runtime.",
        usb,
        wifi,
        reconnectGuidance,
        "Check devices.get for the matching board online in EspHub Bootloader mode. Report what the board confirmed.",
      ].join("\n"),
    };
  }
  return {
    prompt: [
      identify,
      "Read setup_manifest and match its board to the device. Download the ZIP over HTTPS from its GitHub Releases download_url, then flash over USB using INSTALL.txt and flash_args. First-time installation erases flash. Back up any device data before flashing.",
      usb,
      wifi,
      reconnectGuidance,
      "Once the bootloader is online after Wi-Fi setup, call bootloader.exit to start the installed runtime, or power-cycle the board. Check devices.get with this registration ID to confirm it is online with the matching board and MicroPython Runtime (role app). Stage verification_source with programs.publish. Call bootloader.enter, wait for the device to come online in EspHub Bootloader mode, then call ota.install with kind python and the staged URL. For a queued response, use commands.get with command_id until succeeded. Check programs.get for the confirmed transfer ID and devices.get for a new app boot. Verify the board-specific hello on the display or USB console. Report what the board confirmed.",
    ].join("\n"),
    setup_manifest: base + "setup-manifest",
    verification_source: profile.hello,
  };
}
