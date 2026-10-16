import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The studio's page. The server runs Vite in middleware mode and injects the
// session token into index.html, so `vite dev` on its own is never used.
export default defineConfig({
  base: "/",
  plugins: [viteReact()],
  build: { outDir: "dist", emptyOutDir: true },
});
