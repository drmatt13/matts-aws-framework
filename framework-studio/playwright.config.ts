import { defineConfig, devices } from "@playwright/test";

const baseline = process.env.STUDIO_BROWSER_BASELINE === "1";
// Vite resolves outDir relative to each entry root. Keep these shell-safe paths
// relative so checkouts containing spaces do not need shell interpolation.
const frozen = "../.framework/artifacts/studio-tailwind-baseline";
export default defineConfig({
  testDir: "./test/browser", testMatch: "**/*.spec.ts", fullyParallel: false, workers: 2, retries: 0,
  timeout: 30_000, expect: { timeout: 7000, toHaveScreenshot: { animations: "disabled", caret: "hide", threshold: 0.1, maxDiffPixels: 0 } },
  outputDir: "../output/playwright/studio/results", reporter: [["list"], ["html", { outputFolder: "../output/playwright/studio/report", open: "never" }]],
  use: { baseURL: "http://127.0.0.1:4592", viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce", serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium-light", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 }, colorScheme: "light" } },
    { name: "chromium-dark", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 }, colorScheme: "dark" } },
    { name: "firefox-smoke", testMatch: "**/shell.spec.ts", grep: /six destinations/, use: { ...devices["Desktop Firefox"] } },
    { name: "webkit-smoke", testMatch: "**/shell.spec.ts", grep: /six destinations/, use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    { command: `${baseline ? "" : "npm run build && "}vite preview --host 127.0.0.1 --port 4592 --strictPort${baseline ? ` --outDir ${frozen}/app` : ""}`, cwd: __dirname, url: "http://127.0.0.1:4592", reuseExistingServer: false, timeout: 120_000 },
    { command: `${baseline ? "" : "npm run build:browser-gallery && "}vite preview --config test/browser/vite.config.mts --host 127.0.0.1 --port 4593 --strictPort${baseline ? ` --outDir ../../../../.framework/artifacts/studio-tailwind-baseline/gallery` : ""}`, cwd: __dirname, url: "http://127.0.0.1:4593", reuseExistingServer: false, timeout: 120_000 },
  ],
});
