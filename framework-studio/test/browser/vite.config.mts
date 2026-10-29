import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import studio from "../../vite.config.mts";

// A separate built entry, never imported by the production route tree.
export default mergeConfig(studio, {
  root: fileURLToPath(new URL("./gallery", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../public", import.meta.url)),
  build: { outDir: fileURLToPath(new URL("./.dist/gallery", import.meta.url)), emptyOutDir: true },
});
