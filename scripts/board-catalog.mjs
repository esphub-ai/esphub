import { readdir, readFile, writeFile } from "node:fs/promises";
const root = new URL("../firmware/boards/", import.meta.url);
const boards = {};
for (const directory of await readdir(root, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const id = directory.name;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    throw Error("Invalid board directory: " + id);
  const file = (name) => readFile(new URL(id + "/" + name, root), "utf8");
  const { name, model, chip, flash_mb, bootloader } = JSON.parse(
    await file("board.json"),
  );
  if (![name, model, chip].every((v) => typeof v === "string" && v.length))
    throw Error("Invalid metadata for " + id);
  boards[id] = {
    name,
    model,
    chip,
    flash_mb,
    bootloader,
    hello: await file("hello.py"),
  };
}
await writeFile(
  new URL("../shared/boards.generated.json", import.meta.url),
  JSON.stringify(boards) + "\n",
);

const sdkHeader = await readFile(
  new URL(
    "../firmware/components/okou_agent/include/okou_agent.h",
    import.meta.url,
  ),
  "utf8",
);
const sdkVersion = sdkHeader.match(
  /^#define OKOU_SDK_VERSION "([^"]+)"$/m,
)?.[1];
if (!sdkVersion) throw Error("Missing EspHub SDK version");
await writeFile(
  new URL("../shared/sdk.generated.json", import.meta.url),
  JSON.stringify({ version: sdkVersion }) + "\n",
);
