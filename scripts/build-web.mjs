import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../services/web/", import.meta.url));
await build({
  root,
  base: "/ui/",
  configFile: false,
  publicDir: false,
  plugins: [tailwindcss()],
  resolve: { alias: { "@": root + "src" } },
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "public/ui",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
