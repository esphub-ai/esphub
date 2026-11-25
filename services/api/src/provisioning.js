import boards from "../../../shared/boards.generated.json" with { type: "json" };

export const reconnectGuidance =
  "Some physical devices may stay offline after a reboot or a switch to the bootloader. Record devices.get process_id before the transition. Allow time for Wi-Fi to reconnect, then check for online=true, a new process_id and the expected info.role (bootloader or app). Offline boot details describe the last reported session. If the device stays offline and no firmware write is in progress, ask the user to power it off and on, then check again. It may return to the app. Confirm bootloader mode before starting OTA.";

export function provisioning(board) {
  const base = `https://api.esphub.ai/releases/${board}/`;
  const profile = boards[board];
  const identify = `Identify the USB board. If the port or model is ambiguous, ask the user. Check the physical model as well as the ${profile.chip} chip. Proceed with the registered ${profile.model}.`;
  const usb =
    'Use python3 provision_usb.py PORT from the setup kit (also at tools/ble-wifi/provision_usb.py) with pyserial, an authenticated Okou CLI and the private registration JSON on stdin. For another MCP client, send OKL-PROVISION {"hub":"api.esphub.ai","token":"<token>","ble_secret":"<ble_secret>"} with a newline over USB at 115200. Use the plain hostname and credentials returned at registration. On OKL-PROVISION-OK, read the JSON receipt. If it contains ble_address, pass that address and this registration ID to devices.bind_ble_address. Keep credentials private.';
  const wifi =
    "On the Mac, pass wifi.ble_credential to tools/ble-wifi/macos.py as private JSON on stdin. Keep the board in EspHub Bootloader mode for the BLE connection. Select a listed network or enter a hidden SSID, then enter its password locally.";
  const flashKit =
    "Read setup_manifest and match its board to the device. Download the ZIP over HTTPS from its download_url, then flash over USB using INSTALL.txt and flash_args. First-time installation erases flash. Back up any device data before flashing.";
  if (profile.runtime === "native") {
    return {
      setup_manifest: base + "setup-manifest",
      board_setup_guide_url: `https://github.com/okou-ai/esphub-firmware/blob/main/${profile.directory}/README.md`,
      prompt: [
        identify,
        flashKit,
        usb,
        wifi,
        reconnectGuidance,
        "Once the bootloader is online after Wi-Fi setup, call bootloader.exit. Check devices.get for a new session online with role app and runtime type native. Check the screen for Espressif’s Hello World.",
      ].join("\n"),
    };
  }
  if (profile.preview) {
    return {
      board_setup_guide_url: `https://github.com/okou-ai/esphub-firmware/blob/main/${profile.directory}/README.md#bootloader-only-registration`,
      prompt: [
        identify,
        "Use the matching EspHub Bootloader for this board. Follow the board source guide for USB flashing.",
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
      flashKit,
      usb,
      wifi,
      reconnectGuidance,
      "Once the bootloader is online after Wi-Fi setup, call bootloader.exit to start the installed runtime, or power-cycle the board. Check devices.get with this registration ID to confirm it is online with the matching board and MicroPython Runtime (role app). Stage verification_source with programs.publish. Call bootloader.enter, wait for the device to come online in EspHub Bootloader mode, then call ota.install with kind python and the staged URL. For a queued response, use commands.get with command_id until succeeded. Check programs.get for the confirmed transfer ID and devices.get for a new app boot. Verify the board-specific hello on the display or USB console. Report what the board confirmed.",
    ].join("\n"),
    setup_manifest: base + "setup-manifest",
    verification_source: profile.hello,
  };
}
