import { isDeepStrictEqual } from "node:util";
import { releaseUrl } from "../shared/identity.js";

// The release tags published when this migration first ran. The Hub no longer derives tags.
const releaseTag = (kind, board, version) =>
  `firmware-${kind}-${board.replace("/", "_")}-v${version}`;

export default async function removeReleaseManifestCopy(tx) {
  // During cutover the version-only publisher may already have advanced a row.
  // Verify the copy's own version against its immutable download.
  const copies = () => tx`SELECT board, manifest FROM esphub.firmware_releases
    WHERE manifest IS NOT NULL ORDER BY board, kind`;
  const rows = await copies();
  for (const { board, manifest } of rows) {
    const tag = releaseTag("bootloader", board, manifest.version);
    const url = releaseUrl(board, "manifest", tag);
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok || !isDeepStrictEqual(await response.json(), manifest))
      throw Error("Cannot verify the archived bootloader manifest: " + url);
  }

  // Block publishers only for the final comparison and DDL.
  await tx`LOCK TABLE esphub.firmware_releases IN ACCESS EXCLUSIVE MODE`;
  if (!isDeepStrictEqual(rows, await copies()))
    throw Error("Stored release manifests changed during verification. Retry the migration.");
  await tx`ALTER TABLE esphub.firmware_releases DROP COLUMN manifest`;
}
