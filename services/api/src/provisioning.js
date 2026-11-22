import boards from "../../../shared/boards.generated.json" with { type: "json" };

export function provisioning(board) {
  const base = `https://api.esphub.ai/releases/${board}/`;
  return {
    prompt: [
      `Identify the USB board. If the port or model is ambiguous, ask the user. Check the physical model as well as the ${boards[board].chip} chip. Proceed with the registered ${boards[board].model}.`,
      "Read setup_manifest and match its board to the device. Download the ZIP over HTTPS from its GitHub Releases download_url, then flash over USB using INSTALL.txt and flash_args. First-time installation replaces the partition table and app. If the board has data to keep, confirm a backup before flashing.",
      ...(board === "paper-color" ? [
        'Send OKL-PROVISION {"hub":"api.esphub.ai","token":"<token>","ble_secret":"<ble_secret>"} with a newline over USB at 115200. Use the values returned at registration. Wait for OKL-PROVISION-OK. Keep the response private.',
        "On the Mac, pass wifi.ble_credential to tools/ble-wifi/macos.py as private JSON on stdin. Select the Wi-Fi network and enter its password locally.",
      ] : [
      "Open the launcher USB serial port at 115200 baud and send wifi scan followed by a newline. Number the device's results. Ask which number to join, or accept a hidden SSID. Collect the password privately on the host for a secured network.",
      'Send one newline-terminated USB line using this template: OKL-PROVISION {"hub":"<hub>","token":"<token>","wifi":{"ssid":"<ssid>","pass":"<password>","hidden":false}}. JSON-encode the actual values locally. Set hidden to true for a hidden SSID and use an empty pass for an open network. Keep credentials out of chat and logs. Wait for OKL-PROVISION-OK.',
      ]),
      "Poll devices.get with this registration ID until it is online with the matching board and role app. Stage verification_source with programs.publish. Call launcher.enter, wait for the online launcher, then call ota.install with kind python and the staged URL. Use uart.read on the returned process_id after the cursor to check install.done for the transfer_id. Wait for a new app boot and read its output for program.applied and the board-specific hello. Report what the board confirmed.",
    ].join("\n"),
    setup_manifest: base + "setup-manifest",
    verification_source: boards[board].hello,
  };
}
