import { releaseUrl } from "../../../shared/identity.js";

const repo = "https://github.com/okou-ai/esphub-firmware";

export function runtimeDownloadUrl(board) {
  return releaseUrl(board, "micropython");
}

export function updateSources(boardProfile) {
  const {
    id: board,
    preview,
    bootloader,
    runtime,
    has_setup,
    source_revision,
    sdk_version,
  } = boardProfile;
  const tree = repo + "/tree/" + source_revision;
  const blob = repo + "/blob/" + source_revision;
  const profile = "/firmware/board/" + board;
  const sdkSource = tree + "/firmware/components/okou_agent";
  return {
    firmware_update: {
      bootloader: {
        ...(!has_setup
          ? { usb_url: releaseUrl(board, "usb") }
          : {
              setup_manifest_url: releaseUrl(board, "setup-manifest"),
            }),
        download_url: releaseUrl(board, "ota"),
        instructions:
          "For the latest official EspHub Bootloader, call ota.install with kind bootloader and omit url.",
      },
      ...(runtime === "native" && {
        program: {
          download_url: releaseUrl(board, "native"),
          sdk_version,
          sdk_source_url: sdkSource,
          instructions:
            "Enter EspHub Bootloader mode with bootloader.enter, then call ota.install with kind native and this URL. Verify the install receipt and devices.get for the new native app boot.",
        },
      }),
      ...(!preview &&
        runtime === "micropython" && {
          runtime: {
            download_url: runtimeDownloadUrl(board),
            instructions:
              "Use bootloader.enter, wait for EspHub Bootloader mode (role bootloader), then call ota.install with kind micropython and this URL. Verify the install event and the new Runtime boot.",
          },
          program: {
            sdk_version,
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
      ...(runtime === "native" && {
        native: {
          directory_url: tree + profile + "/native",
          build_action_url: blob + profile + "/native/action.yml",
          artifact: "Board-specific native example (*.bin)",
        },
      }),
      ...(!preview &&
        runtime === "micropython" && {
          micropython: {
            directory_url: tree + "/firmware/pyrt",
            upstream_directory_url: `https://github.com/${boardProfile.upstream_repository}/tree/${boardProfile.upstream_ref}`,
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
    custom_build_guide_url:
      "https://github.com/okou-ai/esphub/blob/main/README.md#build-your-own-update",
  };
}
