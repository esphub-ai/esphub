import { describeExamples } from "../../firmware-source/shared/board-examples.js";
import { assetNames, releaseTag } from "../../firmware-source/shared/firmware-releases.js";

export const fixtureVersion = "2.0.7";

export function setupRelease(board, profile, revision) {
  const tag = releaseTag("setup", board, fixtureVersion);
  const names = assetNames(board, profile.chip, "setup", fixtureVersion);
  const example = describeExamples(board, profile.examples, revision).find(
    (item) => item.id === profile.default_example,
  );
  const manifest = { tag, board, version: fixtureVersion, example };
  const files = new Map([
    [`releases/${tag}/published.json`, JSON.stringify({ assets: Object.values(names).map(name => ({ name })) })],
    [`releases/${tag}/${names["setup-manifest"]}`, JSON.stringify(manifest)],
  ]);
  return { files, manifest };
}

export function jsonBucket(files) {
  return { async get(key) {
    const text = files.get(key);
    if (!text) return null;
    return { json: async () => JSON.parse(text), writeHttpMetadata() {} };
  } };
}
