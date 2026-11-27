const fixtureVersion = "2.0.7";

// A setup release as the firmware publisher records it. The Hub treats tags and object
// keys as opaque, so the fixture deliberately uses its own naming.
export function setupRelease(board, profile, example) {
  example ??= profile.published_examples.find((item) => item.id === profile.default_example);
  const tag = `fixture-setup-${board.replace("/", "-")}-${fixtureVersion}`;
  const manifest = { tag, board, version: fixtureVersion, example };
  const keys = { setup: `fixture/${tag}/kit.zip`, "setup-manifest": `fixture/${tag}/kit.json` };
  const files = new Map([[keys["setup-manifest"], JSON.stringify(manifest)]]);
  const assets = Object.entries(keys).map(([asset, object_key]) => ({
    tag, asset, board, object_key, size: null,
  }));
  return { tag, files, assets, manifest };
}

export async function recordRelease(sql, { tag, assets }) {
  const [{ board }] = assets;
  await sql`INSERT INTO esphub.release_assets ${sql(assets)} ON CONFLICT (tag, asset) DO NOTHING`;
  await sql`INSERT INTO esphub.firmware_releases (board, kind, version, tag)
    VALUES (${board}, 'setup', ${fixtureVersion}, ${tag})
    ON CONFLICT (board, kind) DO UPDATE SET version = excluded.version, tag = excluded.tag`;
}

export function jsonBucket(files) {
  return { async get(key) {
    const text = files.get(key);
    if (!text) return null;
    return { json: async () => JSON.parse(text), writeHttpMetadata() {} };
  } };
}
