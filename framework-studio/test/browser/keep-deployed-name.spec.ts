import { test, expect, assertAccessible } from "./support/test";
import { discovery, overview } from "./support/scenarios";

const appId = "5b7e3c1a-9d2f-4e6b-8a1c-3f0d2e9b7a64";

test("a production stage deployed under another name offers to keep that name, through a reviewed cdk.json change", async ({ page, studio }) => {
  const stage = (target: { name: string }) => (target.name === "browser-prod" ? { stage: "prod", appId } : { stage: "dev", appId });
  const observed = {
    ...discovery(),
    targets: discovery().targets.map((target) => ({ ...target, ...stage(target), ...(target.name === "browser-prod" ? { deployedAs: "first-name-prod" } : {}) })),
  };
  studio.reply("GET", "/api/deploy/overview", (route) => route.fulfill({ json: { ...overview(), targets: overview().targets.map((target) => ({ ...target, ...stage(target) })) } }));
  studio.reply("GET", "/api/deploy/discover", (route) => route.fulfill({ json: { ok: true, value: observed } }));
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true, value: { ...observed, deployment: url.searchParams.get("deployment") } } }));
  studio.reply("GET", "/api/app-name", (route) => route.fulfill({ json: { name: "studio-fixture", appId, stages: [{ stage: "dev", mode: "dev", implicit: true }, { stage: "prod", mode: "prod" }], hash: "fixture-hash" } }));
  let reviewed: unknown;
  let applied = false;
  studio.reply("POST", "/api/app-name/deploy-as/review", (route) => {
    reviewed = route.request().postDataJSON();
    return route.fulfill({ json: {
      id: "keep-review", from: "studio-fixture", name: "studio-fixture",
      rows: [{ stage: "prod", mode: "prod", before: "browser-prod", after: "first-name-prod", outcome: "keeps", check: "deployed", deployed: "first-name-prod" }],
      warnings: ["Applying edits cdk-app/cdk.json only; nothing is deployed."],
      change: { file: "cdk-app/cdk.json", before: '{\n  "prod": {}\n}', after: '{\n  "prod": { "deployAs": "first-name-prod" }\n}' },
    } });
  });
  studio.reply("POST", "/api/app-name/apply", (route) => {
    applied = true;
    return route.fulfill({ json: { name: "studio-fixture" } });
  });

  await studio.goto("/deploy");
  await page.getByRole("group", { name: "Source environment", exact: true }).getByRole("button", { name: "Production", exact: true }).click();
  await expect(page.getByText("Deployed as first-name-prod", { exact: true })).toBeVisible();
  await expect(page.getByText("This app's prod stage is already deployed here under that name", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compare AWS templates", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Keep deploying to first-name-prod", exact: true }).first().click();

  const dialog = page.getByRole("dialog", { name: /^Keep deploying to first-name-prod/ });
  await expect(dialog).toContainText("browser-prod → first-name-prod");
  await expect(dialog).toContainText("prod stage · Deployed as this name · keeps it");
  expect(reviewed).toEqual({ stage: "prod", deployAs: "first-name-prod", hash: "fixture-hash" });
  await assertAccessible(page);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(applied).toBe(true);
  expect(studio.requests.some((request) => request.path === "/api/deploy/operations")).toBe(false);
});
