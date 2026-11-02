import type { ModelResource } from "../../shared/model";
import type { ResourceIntent } from "../../shared/resources";
import { test, expect, assertAccessible } from "./support/test";

for (const width of [1440, 390]) for (const managed of [false, true]) test(`edit ${managed ? "framework" : "application"} allowed values through source review at ${width}px`, async ({ page, studio }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width, height: 1000 });
  const id = managed ? "framework:deployment.skipEmailVerification" : "resource:choiceInput";
  const file = managed ? "cdk-app/deployment-inputs.ts" : "framework-config/resources/inputs.ts";
  const resource: ModelResource = { id, kind: "input", absent: false, path: managed ? ["Deployment settings", "skipEmailVerification"] : ["choiceInput"],
    fromEnv: managed ? "SKIP_EMAIL_VERIFICATION" : "CHOICE_INPUT", values: ["true", "false"],
    modes: { dev: { present: true, required: false, ...(!managed ? { default: "false" } : {}) }, prod: { present: true, required: false, ...(!managed ? { default: "false" } : {}) } },
    ...(!managed ? { default: "false" } : { frameworkInput: "deployment", parent: "framework:deployment", inputChoices: { source: { file, line: 1, column: 1, start: 0, end: 20 }, defaults: ["false"] } }),
  };
  for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model, { resources: [...model.resources, structuredClone(resource),
    ...(managed ? [{ id: "framework:deployment", kind: "group", path: ["Deployment settings"], absent: false, frameworkInput: "deployment" }] : [])] });
  studio.reply("GET", "/api/resources/details", async route => route.fulfill({ json: { file: "cdk-app/.env.dev", inputFile: { exists: true, hash: "fixture-input-hash" }, configured: true, value: "private-browser-only" } }));
  let requested: ResourceIntent | undefined;
  studio.reply("POST", "/api/edits/batch/plan", async route => {
    requested = route.request().postDataJSON().edits[0].intent;
    await route.fulfill({ json: { planId: "choices", ok: true, summaries: ["Update allowed values"], changes: [{ file, diff: { unified: `.enum(${JSON.stringify(requested!.choices)})`, lines: [] } }], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } }, impact: [] } });
  });
  studio.reply("POST", "/api/edits/batch/apply", async route => {
    for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model.resources.find(resource => resource.id === id)!, { values: requested!.choices!.length ? requested!.choices : undefined });
    await route.fulfill({ json: { status: "applied", revision: studio.response.snapshot.revision, message: "Saved allowed values." } });
  });
  await studio.goto(`/?select=${encodeURIComponent(id)}`);
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const editor = panel.getByRole("region", { name: "Allowed values", exact: true });
  const review = () => panel.getByRole("button", { name: "Review Changes", exact: true });
  await expect(editor.getByRole("textbox", { name: "Allowed value 1", exact: true })).toHaveValue("true");
  await editor.getByRole("textbox", { name: "Allowed value 2", exact: true }).fill("TRUE");
  await expect(editor).toContainText("Allowed values must be unique");
  await expect(review()).toBeDisabled();
  await editor.getByRole("textbox", { name: "Allowed value 2", exact: true }).fill("other");
  await expect(editor).toContainText("Every declared default or source value must be one of the allowed values.");
  await expect(review()).toBeDisabled();
  await editor.getByRole("textbox", { name: "Allowed value 2", exact: true }).fill("false");
  await expect(panel.getByRole("button", { name: "Review Changes", exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "Add allowed value", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "Allowed value 3", exact: true })).toBeFocused();
  await expect(review()).toBeDisabled();
  await editor.getByRole("textbox", { name: "Allowed value 3", exact: true }).fill("preview");
  await assertAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: info.outputPath("input-allowed-values.png"), animations: "disabled" });
  await review().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(file);
  await expect(dialog).not.toContainText("private-browser-only");
  expect(requested?.choices).toEqual(["true", "false", "preview"]);
  expect(JSON.stringify(requested)).not.toContain("private-browser-only");
  await dialog.getByRole("button", { name: "Back to Editing", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "Allowed value 3", exact: true })).toHaveValue("preview");
  await review().click();
  await dialog.getByRole("button", { name: "Apply All", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(editor.getByRole("textbox", { name: "Allowed value 3", exact: true })).toHaveValue("preview");
  await editor.getByRole("switch", { name: "Restrict allowed values", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(editor.getByRole("textbox")).toHaveCount(0);
  await expect(editor).toContainText("Unrestricted text");
  await review().click();
  expect(requested?.choices).toEqual([]);
  await dialog.getByRole("button", { name: "Back to Editing", exact: true }).click();
  await panel.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "Allowed value 3", exact: true })).toHaveValue("preview");
});
