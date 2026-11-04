import type { ModelResource } from "../../shared/model";
import { withConnectionAuthorizations } from "../../shared/permissions";
import { location } from "./support/scenarios";
import { test, expect, assertAccessible } from "./support/test";

for (const width of [1440, 390, 320]) test(`resource disclosures start closed and preserve keyboard-opened state on Back at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  const stack = "resource:fixture0";
  const member: ModelResource = { id: `${stack}.queue`, kind: "member", path: ["fixture0", "queue"], parent: stack, typeText: "sqs.Queue", memberSource: "class", absent: false };
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model.resources.find(resource => resource.id === stack)!, {
      frameworkStack: true,
      stackOutputs: [{ name: "FixtureQueueArn", envName: "FIXTURE_QUEUE_ARN", symbol: "FixtureStack0.FixtureQueueArn", source: location }],
    });
    Object.assign(model, { resources: [...model.resources, member] });
    Object.assign(model.edges.find(edge => edge.from === "lambda:fixture-0" && edge.to === stack && edge.relation === "grant")!, {
      permissionContext: { kind: "native", method: "grantRead", arguments: [] },
    });
    Object.assign(model, withConnectionAuthorizations(model));
  }
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const content = panel.locator("[data-slot=inspector-content]");
  const disclosure = (title: string) => {
    const summary = panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: new RegExp(`^${title}`) });
    return { summary, details: summary.locator("..") };
  };
  const permissions = disclosure("Permissions");
  const settings = disclosure("Settings");
  await expect(content.locator("details[open]")).toHaveCount(0);
  await expect(permissions.details).not.toHaveAttribute("open");
  await expect(settings.details).not.toHaveAttribute("open");
  await expect(panel.getByRole("button", { name: "Add access", exact: true })).toBeHidden();
  await expect(panel.getByRole("spinbutton", { name: "Memory in MB", exact: true })).toBeHidden();

  await permissions.summary.focus();
  await page.keyboard.press("Space");
  await expect(permissions.details).toHaveAttribute("open", "");
  await expect(panel.getByRole("button", { name: "Add access", exact: true })).toBeVisible();
  await settings.summary.focus();
  await page.keyboard.press("Enter");
  await expect(settings.details).toHaveAttribute("open", "");
  const memory = panel.getByRole("spinbutton", { name: "Memory in MB", exact: true });
  await expect(memory).toBeVisible();
  await memory.fill("1");
  await settings.summary.click();
  await expect(settings.summary).toContainText("Needs attention");
  await expect(page.getByRole("button", { name: "Review Changes", exact: true })).toBeDisabled();
  await settings.summary.click();
  await memory.fill("512");
  await settings.summary.click();
  await expect(settings.summary).toContainText("Modified");
  await settings.summary.click();
  await memory.fill("256");
  await expect(settings.summary).not.toContainText("Modified");
  expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const access = permissions.details.locator("[data-slot=access-summary]").first();
  await access.locator(":scope > summary").click();
  await access.getByRole("button", { name: "Inspect resource", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "FixtureStack0", exact: true })).toBeVisible();
  await expect(content.locator("details[open]")).toHaveCount(0);
  const fields = disclosure("Public fields");
  await expect(fields.details).not.toHaveAttribute("open");
  await expect(disclosure("CloudFormation outputs").details).not.toHaveAttribute("open");
  await expect(panel.getByRole("button", { name: "queue", exact: true })).toBeHidden();
  await fields.summary.focus();
  await page.keyboard.press("Space");
  await expect(panel.getByRole("button", { name: "queue", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(fields.details).not.toHaveAttribute("open");
  await page.keyboard.press("Enter");
  await panel.getByRole("button", { name: "queue", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "queue", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Back to FixtureStack0", exact: true }).click();
  await expect(fields.details).toHaveAttribute("open", "");
  await expect(panel.getByRole("button", { name: "queue", exact: true })).toBeFocused();
  expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.getByRole("button", { name: "Back to Fixture handler 0", exact: true }).click();
  await expect(permissions.details).toHaveAttribute("open", "");
  await expect(settings.details).toHaveAttribute("open", "");
  await expect(access.getByRole("button", { name: "Inspect resource", exact: true })).toBeFocused();
  await assertAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
});
