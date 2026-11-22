import boards from "../../../shared/boards.generated.json" with { type: "json" };

export function provisioning(board) {
  const base = `https://api.esphub.ai/releases/${board}/`;
  return {
    prompt: [
      `Identify the USB board. If the port or model is ambiguous, ask the user. Check the physical model as well as the ${boards[board].chip} chip. Proceed with the registered ${boards[board].model}.`,
      "Read setup_manifest and match its board to the device. Download the ZIP over HTTPS from its GitHub Releases download_url, then flash over USB using INSTALL.txt and flash_args. First-time installation replaces the partition table and app. If the board has data to keep, confirm a backup before flashing.",
      'Send OKL-PROVISION {"hub":"api.esphub.ai","token":"<token>","ble_secret":"<ble_secret>"} with a newline over USB at 115200. Use the plain hostname and credentials returned at registration. Wait for OKL-PROVISION-OK. Keep the response private.',
      "On the Mac, pass wifi.ble_credential to tools/ble-wifi/macos.py as private JSON on stdin. Wait for Beacon ready, then have the user restart the board. Select a listed network or enter a hidden SSID, then enter its password locally.",
      "Poll devices.get with this registration ID until it is online with the matching board and role app. Stage verification_source with programs.publish. Call launcher.enter, wait for the online launcher, then call ota.install with kind python and the staged URL. For a queued response, use commands.get with command_id until succeeded. Use uart.read on the launcher process_id to check the install event for the transfer_id from the command result. Wait for a new app boot and read its output for program.applied and the board-specific hello. Report what the board confirmed.",
    ].join("\n"),
    setup_manifest: base + "setup-manifest",
    verification_source: boards[board].hello,
  };
}
