import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The studio's page. The server runs Vite in middleware mode and injects the
// session token into index.html, so `vite dev` on its own is never used.
export default defineConfig({
  base: "/",
  plugins: [tailwindcss(), viteReact()],
  // Building the isolated browser gallery must not reload an active Studio draft.
  server: { watch: { ignored: ["**/test/browser/.dist/**"] } },
  build: { outDir: "dist", emptyOutDir: true },
});
