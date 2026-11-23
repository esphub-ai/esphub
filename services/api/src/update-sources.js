import sdk from "../../../shared/sdk.generated.json" with { type: "json" };
import boards from "../../../shared/boards.generated.json" with { type: "json" };
import upstream from "../../../firmware/pyrt/upstream.json" with { type: "json" };

const repo = "https://github.com/okou-ai/esphub";
const tree = repo + "/tree/main";
const blob = repo + "/blob/main";

export function runtimeDownloadUrl(board) {
  return `https://api.esphub.ai/releases/${board}/micropython`;
}

export function updateSources(board) {
  const { directory, preview, bootloader } = boards[board];
  const profile = "/" + directory;
  const sdkSource = tree + "/firmware/components/okou_agent";
  return {
    firmware_update: {
      bootloader: {
        ...(preview
          ? { usb_url: `https://api.esphub.ai/releases/${board}/usb` }
          : {
              setup_manifest_url: `https://api.esphub.ai/releases/${board}/setup-manifest`,
            }),
        download_url: `https://api.esphub.ai/releases/${board}/ota`,
        instructions:
          "For the latest official EspHub Bootloader, call ota.install with kind bootloader and omit url.",
      },
      ...(!preview && {
        runtime: {
          download_url: runtimeDownloadUrl(board),
          instructions:
            "Use bootloader.enter, wait for EspHub Bootloader mode (role bootloader), then call ota.install with kind micropython and this URL. Verify the install event and the new Runtime boot.",
        },
        program: {
          sdk_version: sdk.version,
          sdk_source_url: sdkSource,
          instructions:
            "For a Python Program, stage main.py with programs.publish and install its URL in EspHub Bootloader mode with kind python. For a Native Program, enter EspHub Bootloader mode and call ota.install with kind native and the HTTPS URL of the application binary for your hardware. Update older bootloaders first if they do not recognize kind native.",
        },
      }),
    },
    sources: {
      bootloader: {
        directory_url: tree + "/firmware/bootloader/common",
        variant_directory_url: tree + "/firmware/bootloader/" + bootloader,
        board_directory_url: tree + profile + "/layout",
        sdk_directory_url: sdkSource,
        build_action_url: blob + "/scripts/build-bootloader.sh",
        artifact: "Shared EspHub Bootloader OTA binary (*-ota.bin)",
      },
      ...(!preview && {
        micropython: {
          directory_url: tree + "/firmware/pyrt",
          upstream_directory_url: `https://github.com/${upstream.repository}/tree/${upstream.ref}`,
          board_directory_url: tree + profile + "/micropython",
          build_action_url: blob + profile + "/micropython/action.yml",
          artifact: "Board-specific MicroPython Runtime binary (*.bin)",
        },
        python: {
          directory_url: tree + profile,
          starter_file_url: blob + profile + "/main.py",
          artifact: "Python Program in UTF-8 main.py",
        },
      }),
    },
    custom_build_guide_url: blob + "/README.md#build-your-own-update",
  };
}
