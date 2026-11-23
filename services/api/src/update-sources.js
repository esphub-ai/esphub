import sdk from "../../../shared/sdk.generated.json" with { type: "json" };
import upstream from "../../../firmware/pyrt/upstream.json" with { type: "json" };

const repo = "https://github.com/okou-ai/esphub";
const tree = repo + "/tree/main";
const blob = repo + "/blob/main";

export function runtimeDownloadUrl(board) {
  return `https://api.esphub.ai/releases/${board}/micropython`;
}

export function updateSources(board) {
  const profile = "/firmware/boards/" + board;
  const sdkSource = tree + "/firmware/components/okou_agent";
  return {
    firmware_update: {
      bootloader: {
        setup_manifest_url: `https://api.esphub.ai/releases/${board}/setup-manifest`,
        download_url: `https://api.esphub.ai/releases/${board}/ota`,
        instructions:
          "For the latest official EspHub Bootloader, call ota.install with kind bootloader and omit url. For devices on the previous protocol, back up device data and install the current board USB setup kit before using OTA.",
      },
      runtime: {
        download_url: runtimeDownloadUrl(board),
        instructions:
          "Use bootloader.enter, wait for EspHub Bootloader mode (role bootloader), then call ota.install with kind micropython and this URL. Verify the install event and the new Runtime boot.",
      },
      program: {
        sdk_version: sdk.version,
        sdk_source_url: sdkSource,
        instructions:
          "For a Python Program, stage main.py with programs.publish and install its URL in EspHub Bootloader mode with kind python. For a Native Program without MicroPython, compare the installed app SDK version with sdk_version. Rebuild the board-specific firmware with the latest EspHub SDK and deploy through the Program's supported native OTA path. If the Program has no native OTA path, use its documented USB installation procedure. A Native Program needs a compatible writer to update the EspHub Bootloader over OTA.",
      },
    },
    sources: {
      bootloader: {
        directory_url: tree + "/firmware/bootloader",
        board_directory_url: tree + profile + "/layout",
        sdk_directory_url: sdkSource,
        build_action_url: blob + "/scripts/build-bootloader.sh",
        artifact: "Shared EspHub Bootloader OTA binary (*-ota.bin)",
      },
      micropython: {
        directory_url: tree + "/firmware/pyrt",
        upstream_directory_url: `https://github.com/${upstream.repository}/tree/${upstream.ref}`,
        board_directory_url: tree + profile + "/micropython",
        build_action_url: blob + profile + "/micropython/action.yml",
        artifact: "Board-specific MicroPython Runtime binary (*.bin)",
      },
      python: {
        directory_url: tree + profile,
        starter_file_url: blob + profile + "/hello.py",
        artifact: "Python Program in UTF-8 main.py",
      },
    },
    custom_build_guide_url: blob + "/README.md#build-your-own-update",
  };
}
