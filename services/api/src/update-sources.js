import { releaseUrl } from "../../../shared/identity.js";

// Example and source links are published with the board catalog by the firmware publisher.
export function updateSources(profile) {
  const { id } = profile;
  return {
    default_example: profile.default_example,
    examples: profile.published_examples,
    firmware_update: {
      bootloader: { download_url: releaseUrl(id, "ota") },
      app: { download_url: releaseUrl(id, "app") },
    },
    sources: {
      bootloader: { directory_url: profile.bootloader_source_url },
      sdk: { version: profile.sdk_version, directory_url: profile.sdk_source_url },
    },
  };
}
