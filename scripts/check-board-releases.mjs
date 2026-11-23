import boards from "../shared/boards.generated.json" with { type: "json" };
import { publishedFirmware, assetNames } from "../shared/firmware-releases.js";
const index = await publishedFirmware(boards, fetch, process.env.GH_TOKEN);
for (const [board, { chip, preview }] of Object.entries(boards)) {
  if (preview) continue;
  const release = index[board].setup;
  if (!release) throw Error("Missing USB kit for " + board);
  const name = assetNames(board, chip, "setup", release.version)[
    "setup-manifest"
  ];
  const result = await fetch(
    `https://github.com/okou-ai/esphub/releases/download/${release.tag}/${name}`,
  );
  if (!result.ok) throw Error("Missing manifest: " + name);
  const m = await result.json();
  if (
    m.board !== board ||
    m.chip !== chip ||
    m.version !== release.version ||
    !(m.runtime_size > 0)
  )
    throw Error("Invalid kit: " + name);
  console.log(board, release.tag);
}
