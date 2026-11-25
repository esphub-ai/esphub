import { releaseUrl } from "../../../shared/identity.js";
import { describeExamples } from "../../../firmware-source/shared/board-examples.js";

export function updateSources(profile) {
  const { id, bootloader, source_revision, sdk_version } = profile;
  const tree = "https://github.com/okou-ai/esphub-firmware/tree/" + source_revision;
  return {
    default_example: profile.default_example,
    examples: describeExamples(id, profile.examples, source_revision),
    firmware_update: {
      bootloader: { download_url: releaseUrl(id, "ota") },
      app: { download_url: releaseUrl(id, "app") },
    },
    sources: {
      bootloader: { directory_url: tree + "/firmware/bootloader/" + bootloader },
      sdk: { version: sdk_version, directory_url: tree + "/firmware/components/eh_agent" },
    },
  };
}
