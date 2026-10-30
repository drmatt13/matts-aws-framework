import type { BatchPlanResponse, DraftEdit } from "../../shared/api";
import { batchPlan } from "./support/scenarios";
import { test, expect, assertAccessible } from "./support/test";

const file = "framework-config/descriptions.ts";
const commentId = "fixture-description-comment";
const note = "// Keep the deployment team's explanation until its replacement has been reviewed.";
const vscodeUrl = `vscode://file//studio-fixture/${file}:12:3`;

interface PlanRequest {
  readonly edits: readonly DraftEdit[];
  readonly revision: string;
  readonly options?: { readonly comments?: Readonly<Record<string, "keep" | "remove">> };
}

test("long source comments remain bounded and keyboard scrollable on a narrow screen", async ({ page, studio }) => {
  await page.setViewportSize({ width: 420, height: 1000 });
  const prose = ["/**", ...Array.from({ length: 28 }, (_, index) => ` * Explanation ${index + 1}: preserve the deployment rationale for future maintainers.`), " */"];
  const plan = commentPlan();
  studio.reply("POST", "/api/edits/batch/plan", async route => {
    await route.fulfill({ json: {
      ...plan,
      comments: plan.comments!.map(comment => ({ ...comment, text: prose.join("\n") })),
      changes: [{ file, operation: "modify", diff: { unified: "", lines: [
        ...prose.map((text, index) => ({ kind: "context", text: `  ${text}`, oldLine: index + 12, newLine: index + 12 })),
        { kind: "remove", text: '  "lambda:fixture-0": "A deterministic fixture for Studio browser checks.",', oldLine: prose.length + 12 },
      ] } }],
    } });
  });
  await studio.goto("/?select=lambda%3Afixture-0");
  const description = page.getByRole("region", { name: "Node description" });
  await description.locator("summary").click();
  await description.getByRole("textbox", { name: "Description", exact: true }).fill("");
  await page.getByRole("button", { name: "Review Changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review 1 change", exact: true });
  const choices = dialog.getByRole("region", { name: "Source comment choices", exact: true });
  await expect(choices).toBeVisible();
  const dimensions = await choices.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight }));
  expect(dimensions.height).toBeLessThanOrEqual(256);
  expect(dimensions.content).toBeGreaterThan(dimensions.height);
  await choices.focus();
  await expect(choices).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => choices.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assertAccessible(page);
  expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
});

function commentPlan(resolution: "keep" | "remove" = "keep", manualReason?: string): BatchPlanResponse {
  return {
    ...batchPlan(),
    planId: `comment-plan-${resolution}`,
    summaries: ["Remove the fixture description"],
    ok: !manualReason,
    comments: [{ id: commentId, file, line: 12, column: 3, text: note, resolution, vscodeUrl, ...(manualReason ? { manualReason } : {}) }],
    changes: [{ file, operation: "modify", diff: { unified: "", lines: [
      { kind: "context", text: "export const descriptions = {", oldLine: 11, newLine: 11 },
      resolution === "keep" ? { kind: "context", text: `  ${note}`, oldLine: 12, newLine: 12 } : { kind: "remove", text: `  ${note}`, oldLine: 12 },
      { kind: "remove", text: '  "lambda:fixture-0": "A deterministic fixture for Studio browser checks.",', oldLine: 13 },
      { kind: "context", text: "};", oldLine: 14, newLine: resolution === "keep" ? 13 : 12 },
    ] } }],
  };
}

for (const width of [1440, 420]) {
  test(`comment choices rebuild the preview and guard apply at ${width}px`, async ({ page, studio }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 1000 });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let plans = 0;
    studio.reply("POST", "/api/edits/batch/plan", async route => {
      const request = route.request().postDataJSON() as PlanRequest;
      if (++plans === 2) await pending;
      await route.fulfill({ json: commentPlan(request.options?.comments?.[commentId] ?? "keep") });
    });
    studio.reply("POST", "/api/edits/batch/apply", async route => {
      expect(route.request().postDataJSON()).toEqual({ planId: "comment-plan-remove" });
      const snapshot = studio.response.snapshot;
      Object.assign(studio.response, { snapshot: { ...snapshot, revision: "comment-saved", descriptions: { values: {} } } });
      await route.fulfill({ json: { status: "applied", message: "Saved the reviewed description and comment removal.", revision: "comment-saved" } });
    });
    await studio.goto("/?select=lambda%3Afixture-0");
    const description = page.getByRole("region", { name: "Node description" });
    await description.locator("summary").click();
    await description.getByRole("textbox", { name: "Description", exact: true }).fill("");
    await page.getByRole("button", { name: "Review Changes", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Review 1 change", exact: true });
    const apply = dialog.getByRole("button", { name: "Apply All", exact: true });
    const checkbox = dialog.getByRole("checkbox", { name: /^Remove this comment/ });
    const diff = dialog.getByLabel(`Changes to ${file}`, { exact: true });
    await expect(checkbox).not.toBeChecked();
    await expect(diff.locator("tr").filter({ hasText: note })).not.toHaveClass(/bg-removed/);
    await expect(apply).toBeEnabled();
    await expect(dialog.locator('a[href^="vscode:"]').first()).toHaveAttribute("href", vscodeUrl);
    await checkbox.focus();
    await expect(checkbox).toBeFocused();
    try {
      await page.keyboard.press("Space");
      await expect(apply).toBeDisabled();
      await expect(dialog.getByRole("status").filter({ hasText: /Checking|Updating/ })).toBeVisible();
      await expect(checkbox).toBeFocused();
      await expect(checkbox).toHaveAttribute("aria-disabled", "true");
      await expect.poll(() => plans).toBe(2);
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await expect(checkbox).toBeFocused();
      expect(studio.requests.filter(request => request.path === "/api/edits/batch/plan")).toHaveLength(2);
      expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
    } finally { release(); }
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeFocused();
    await expect(checkbox).toHaveAttribute("aria-disabled", "false");
    await expect(apply).toBeEnabled();
    expect(studio.requests.filter(request => request.path === "/api/edits/batch/plan")).toHaveLength(2);
    await expect(diff.locator("tr").filter({ hasText: note })).toHaveClass(/bg-removed/);
    const request = studio.requests.filter(request => request.path === "/api/edits/batch/plan").at(-1)!.body as PlanRequest;
    expect(request.options?.comments).toEqual({ [commentId]: "remove" });
    expect(request.edits).toEqual([{ kind: "description", entity: "lambda:fixture-0", value: "" }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    if (width === 420) {
      await diff.focus();
      await expect(diff).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => diff.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    }
    await assertAccessible(page);
    await apply.click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Saved the reviewed description and comment removal.", { exact: true })).toBeVisible();
    expect(studio.requests.filter(request => request.path === "/api/edits/batch/apply")).toHaveLength(1);
  });

  test(`manual comment resolution refreshes source and preserves the draft at ${width}px`, async ({ page, studio }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 1000 });
    const reason = "This compiler directive could affect neighboring code. Resolve its placement in your editor.";
    let refreshed = false;
    studio.reply("POST", "/api/edits/batch/plan", async route => {
      await route.fulfill({ json: refreshed ? { ...commentPlan(), comments: [], planId: "after-manual-resolution" } : commentPlan("keep", reason) });
    });
    studio.reply("POST", "/api/snapshot/refresh", async route => {
      refreshed = true;
      Object.assign(studio.response, { snapshot: { ...studio.response.snapshot, revision: "manual-source-revision" } });
      await route.fulfill({ json: { revision: "manual-source-revision" } });
    });
    await studio.goto("/?select=lambda%3Afixture-0");
    const description = page.getByRole("region", { name: "Node description" });
    await description.locator("summary").click();
    await description.getByRole("textbox", { name: "Description", exact: true }).fill("");
    await page.getByRole("button", { name: "Review Changes", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Review 1 change", exact: true });
    await expect(dialog.getByText(reason, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel(`Changes to ${file}`, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Apply All", exact: true })).toBeDisabled();
    await expect(dialog.locator('a[href^="vscode:"]').first()).toHaveAttribute("href", vscodeUrl);
    await assertAccessible(page);
    const retry = dialog.getByRole("button", { name: "Refresh source and retry", exact: true });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
    const requests = studio.requests.filter(request => request.path === "/api/edits/batch/plan");
    expect(requests).toHaveLength(2);
    const initial = requests[0]!.body as PlanRequest, retried = requests[1]!.body as PlanRequest;
    expect(initial.revision).toBe("browser-revision");
    expect(retried.revision).toBe("manual-source-revision");
    expect(retried.edits).toEqual(initial.edits);
    const paths = studio.requests.map(request => `${request.method} ${request.path}`);
    const refreshIndex = paths.indexOf("POST /api/snapshot/refresh");
    const retryIndex = paths.lastIndexOf("POST /api/edits/batch/plan");
    expect(refreshIndex).toBeGreaterThan(-1);
    expect(paths.slice(refreshIndex + 1, retryIndex)).toContain("GET /api/snapshot");
    await dialog.getByRole("button", { name: "Back to Editing", exact: true }).click();
    await expect(description.getByRole("textbox", { name: "Description", exact: true })).toHaveValue("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
  });
}
