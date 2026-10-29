import { registerHooks } from "node:module";

// Node UI suites exercise component behavior without a browser CSS engine.
// Keep route-owned CSS imports native in Vite; browser tests verify their styling.
registerHooks({
  load(url, context, nextLoad) {
    if (new URL(url).pathname.endsWith(".css")) {
      return { format: "module", source: "export {};", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
