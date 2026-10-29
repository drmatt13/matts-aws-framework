import { test, expect } from "./support/test";
import { deploymentPlan, identity, overview } from "./support/scenarios";
import { writeFile } from "node:fs/promises";

test("baseline Cognito provider evidence and permissions remain bounded", async ({ page, studio }) => {
  await studio.goto("/cognito/providers");
  const evidence = page.getByRole("region", { name: "Provider verification evidence" });
  await expect(evidence).toBeVisible();
  await studio.settle();
  await expect(page).toHaveScreenshot("cognito-providers.png", { fullPage: true });
  await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: "Permissions & RBAC", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Permission layers", exact: true })).toBeVisible();
  await studio.settle();
  await expect(page).toHaveScreenshot("cognito-permissions.png", { fullPage: true });
  await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: "Identity Pools", exact: true }).click();
  await expect(page.getByRole("list", { name: "AWS access relationship" })).toBeVisible();
  await studio.settle();
  await expect(page).toHaveScreenshot("cognito-identity-pools.png", { fullPage: true });
  await page.setViewportSize({ width: 420, height: 850 });
  await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: "Providers", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await evidence.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(420);
  expect(await evidence.locator("table").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(820);
});

test("baseline scrolled Cognito management and expanded retention keep form geometry", async ({ page, studio }, testInfo) => {
  await studio.goto("/cognito");
  const management = page.getByRole("region", { name: "Cognito user and group management" });
  await management.evaluate(element => element.scrollIntoView({ block: "start", inline: "nearest" }));
  await studio.settle();
  await expect(page).toHaveScreenshot("cognito-management-scrolled.png", { fullPage: true });
  await page.getByText("Retention and retained pool reuse", { exact: true }).click();
  const retention = page.getByRole("region", { name: "Stateful retention and reuse" });
  await retention.evaluate(element => element.scrollIntoView({ block: "start", inline: "nearest" }));
  await expect(retention.getByRole("combobox", { name: "Retention environment" })).toBeInViewport();
  const metrics = await retention.evaluate(element => [...element.querySelectorAll("h2,h3,p,label,summary,input,select")].map(child => {
    const style = getComputedStyle(child), bounds = child.getBoundingClientRect();
    return { tag: child.tagName, text: child.getAttribute("aria-label") ?? child.textContent?.trim().slice(0, 65), font: style.font, margin: style.margin, padding: style.padding, display: style.display, gap: style.gap, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }));
  await writeFile(testInfo.outputPath("retention-metrics.json"), JSON.stringify(metrics, null, 2));
  await studio.settle();
  await expect(page).toHaveScreenshot("cognito-retention-expanded.png", { fullPage: true });
});

test("Cognito subsection navigation retains the selected profile and independent source retry", async ({ page, studio }) => {
  let unavailable = true;
  studio.reply("GET", "/api/identity/source", (route, url) => route.fulfill(unavailable ? { status: 500, json: { error: "Fixture identity source unavailable" } } : { json: identity(url.searchParams.get("mode") === "prod" ? "prod" : "dev") }));
  await studio.goto("/cognito");
  await expect(page.getByRole("alert").filter({ hasText: "Fixture identity source unavailable" })).toBeVisible({ timeout: 12_000 });
  unavailable = false;
  await page.getByRole("button", { name: "Retry source", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Fixture identity source unavailable" })).not.toBeVisible();
  const profile = page.getByLabel("Identity AWS profile", { exact: true });
  await profile.fill("typed-profile");
  await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: "Providers", exact: true }).click();
  await expect(profile).toHaveValue("typed-profile");
  await expect(page.getByRole("heading", { name: "Federation providers", exact: true })).toBeVisible();
  expect(studio.requests.some(request => request.path.startsWith("/api/identity/cognito"))).toBe(false);
});

test("Domains source failures recover independently of deployment context", async ({ page, studio }) => {
  let unavailable = true;
  studio.reply("GET", "/api/identity/source", route => route.fulfill(unavailable ? { status: 500, json: { error: "Fixture domain source unavailable" } } : { json: identity("prod") }));
  await studio.goto("/domains");
  await expect(page.getByRole("combobox", { name: "Identity deployment" })).toHaveValue("browser-prod");
  await expect(page.getByRole("alert").filter({ hasText: "Fixture domain source unavailable" })).toBeVisible({ timeout: 12_000 });
  unavailable = false;
  await page.getByRole("button", { name: "Retry source", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Fixture domain source unavailable" })).not.toBeVisible();
  await expect(page.getByRole("combobox", { name: "Identity deployment" })).toHaveValue("browser-prod");
});

test("baseline deployment review keeps typed confirmation and no implicit operation", async ({ page, studio }) => {
  const plan = deploymentPlan();
  studio.reply("GET", "/api/deploy/plans", route => route.fulfill({ json: [{ key: plan.key, deployment: plan.identity.deployment, mode: plan.identity.mode, status: plan.status, createdAt: plan.createdAt, expired: false, account: plan.identity.account, region: plan.identity.region, profile: "browser" }] }));
  studio.reply("GET", "/api/deploy/plans/browser-plan", route => route.fulfill({ json: plan }));
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Review plan", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: /Review plan for browser-dev/ });
  const apply = dialog.getByRole("button", { name: "Apply to 123456789012" });
  await expect(apply).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Type browser-dev to apply" }).fill("browser-dev");
  await expect(apply).toBeEnabled();
  await studio.settle();
  await expect(page).toHaveScreenshot("deployment-review.png", { fullPage: true });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  expect(studio.requests.filter(request => request.path === "/api/deploy/operations")).toHaveLength(0);
});

test("failed refresh preserves the deployment and shows persistent retry evidence", async ({ page, studio }) => {
  let unavailable = false;
  studio.reply("GET", "/api/deploy/overview", route => route.fulfill(unavailable ? { status: 500, json: { error: "Fixture refresh failed" } } : { json: overview() }));
  await studio.goto("/deploy");
  await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
  unavailable = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Fixture refresh failed" })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
});
