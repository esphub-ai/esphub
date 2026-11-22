import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { tools } from "../services/api/src/operations.js";
await build({
  entryPoints: ["services/web/src/app.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "services/web/public/app.js",
});
await writeFile("services/web/public/tools.json", JSON.stringify(tools));
