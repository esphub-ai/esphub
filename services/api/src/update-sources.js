// Example and source links are published with the board catalog by the firmware publisher.
export function updateSources(profile, firmware) {
  return {
    default_example: profile.default_example,
    examples: profile.published_examples,
    firmware,
    sources: {
      bootloader: { directory_url: profile.bootloader_source_url },
      sdk: { version: profile.sdk_version, directory_url: profile.sdk_source_url },
    },
  };
}
