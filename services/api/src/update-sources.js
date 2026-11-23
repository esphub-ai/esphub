import upstream from "../../../firmware/pyrt/upstream.json" with { type: "json" };

const repo = "https://github.com/okou-ai/esphub";
const tree = repo + "/tree/main";
const blob = repo + "/blob/main";

export function updateSources(board) {
  const profile = "/firmware/boards/" + board;
  return {
    sources: {
      launcher: {
        directory_url: tree + "/firmware/bootloader",
        board_directory_url: tree + profile + "/layout",
        sdk_directory_url: tree + "/firmware/components/okou_agent",
        build_action_url: blob + "/scripts/build-bootloader.sh",
        artifact: "Shared bootloader OTA binary (*-ota.bin)",
      },
      micropython: {
        directory_url: tree + "/firmware/pyrt",
        upstream_directory_url: `https://github.com/${upstream.repository}/tree/${upstream.ref}`,
        board_directory_url: tree + profile + "/micropython",
        build_action_url: blob + profile + "/micropython/action.yml",
        artifact: "Board-specific MicroPython application binary (*.bin)",
      },
      python: {
        directory_url: tree + profile,
        starter_file_url: blob + profile + "/hello.py",
        artifact: "Plain UTF-8 main.py",
      },
    },
    custom_build_guide_url: blob + "/README.md#build-your-own-update",
  };
}
