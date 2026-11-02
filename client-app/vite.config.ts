/// <reference types="vitest/config" />
import { resolve } from "node:path";

import { defineConfig, loadEnv } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Bundle the public projection into Vite's Node config rather than asking
// native Node to import the workspace's TypeScript package entry point.
import { AGENT_ROUTE } from "../packages/api-contract/src/generated/framework-routes";
import { developmentApiProxy } from "./dev-proxy";

const config = defineConfig(({ command, mode }) => {
  // Export generates client settings and the root Compose controls. Its local
  // VITE_API_GATEWAY_URL follows LOCAL_API_DEV_SERVER_HOST_PORT, including the
  // declared default. Layer the root second so the proxy follows the exported
  // host port; change that port in cdk-app/.env.dev rather than authoring a URL.
  const env = {
    ...loadEnv(mode, process.cwd(), ""),
    ...loadEnv(mode, resolve(import.meta.dirname, ".."), ""),
  };
  const apiProxyTarget = env.VITE_API_GATEWAY_URL?.replace(/\/+$/, "");

  // HTTP routes use /api; agent routes use their explicit same-origin paths.
  // VITE_API_GATEWAY_URL is no longer
  // read by application code -- it is only this proxy's target.
  //
  // Not enforced under `mode === "test"`: Vitest resolves this config with
  // command "serve", and .env is gitignored, so a fresh clone would fail to
  // run its tests for a reason that has nothing to do with them.
  if (command === "serve" && mode !== "test" && !apiProxyTarget) {
    throw new Error(
      "VITE_API_GATEWAY_URL is required as the local /api proxy target. See client-app/.env.example.",
    );
  }

  return {
    base: "/",
    resolve: {
      tsconfigPaths: true,
    },
    server: apiProxyTarget
      ? {
          proxy: developmentApiProxy(apiProxyTarget, AGENT_ROUTE),
        }
      : undefined,
    plugins: [
      devtools(),
      tailwindcss(),
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
      }),
      viteReact(),
    ],
    test: {
      // Node 25+ defines its own localStorage global, which is undefined without
      // --localstorage-file and hides jsdom's, so every storage-backed test fails.
      execArgv: ["--no-experimental-webstorage"],
    },
  };
});

export default config;
