import { readdir, readFile, writeFile } from "node:fs/promises";
const root = new URL("../firmware/boards/", import.meta.url);
const boards = {};
for (const directory of await readdir(root, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const id = directory.name;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    throw Error("Invalid board directory: " + id);
  const file = (name) => readFile(new URL(id + "/" + name, root), "utf8");
  const { name, model, chip, flash_mb } = JSON.parse(await file("board.json"));
  if (![name, model, chip].every((v) => typeof v === "string" && v.length))
    throw Error("Invalid metadata for " + id);
  boards[id] = { name, model, chip, flash_mb, hello: await file("hello.py") };
}
await writeFile(
  new URL("../shared/boards.generated.json", import.meta.url),
  JSON.stringify(boards) + "\n",
);
