import type { Locator, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { Mode, ModelResource } from "../../shared/model";
import { CLIENT_ENVIRONMENT_FILES } from "../../shared/client-environment";
import { location } from "./support/scenarios";
import { test, expect } from "./support/test";

const groupId = "resource:stylingInputs";
const inputId = `${groupId}.label`;
const declaration = { ...location, file: "framework-config/resources.ts", line: 12 };

/** Public, presentation-only values. These declarations never touch source or AWS. */
function resources(mode: Mode): readonly ModelResource[] {
  return [
    {
      id: "resource:stylingManaged",
      path: ["stylingManaged"],
      kind: "stack",
      absent: false,
      stackClass: "ManagedPresentationStack",
      frameworkManaged: "outputs",
      stackUsage: { status: "referenced", sites: [] },
    },
    {
      id: "framework-stack:DetachedPresentationStack",
      path: ["DetachedPresentationStack"],
      kind: "stack",
      absent: false,
      stackClass: "DetachedPresentationStack",
      frameworkStack: true,
      stackUsage: { status: "unreferenced", sites: [] },
    },
    { id: "resource:stylingNoSource", path: ["stylingNoSource"], kind: "construct", absent: false },
    { id: groupId, path: ["stylingInputs"], kind: "group", absent: false },
    {
      id: inputId,
      path: ["stylingInputs", "label"],
      parent: groupId,
      kind: "input",
      absent: false,
      authoredValue: "fixture-label",
      modes: {
        dev: { present: true, required: false, value: "fixture-label" },
        prod: { present: true, required: false, value: "fixture-label" },
      },
    },
    {
      id: "envfile:dev",
      path: ["cdk-app/.env.dev"],
      kind: "envFile",
      absent: mode !== "dev",
      deploymentFile: {
        mode: "dev",
        path: "cdk-app/.env.dev",
        template: "cdk-app/.env.dev.template",
        exists: false,
        entries: [],
      },
    },
    {
      id: "client-envfile",
      path: ["client-app/.env"],
      kind: "envFile",
      absent: false,
      clientEnvironment: {
        mode,
        path: CLIENT_ENVIRONMENT_FILES[mode],
        inputs: `cdk-app/.env.${mode}`,
        entries: [],
        options: [],
        mappings: { VITE_PRESENTATION: { kind: "empty" } },
      },
    },
  ];
}

async function capture(scope: Locator, name: string, info: TestInfo) {
  const metrics = await scope.evaluate((element) =>
    [...element.querySelectorAll("h2,h3,p,dl,dt,dd,summary,button,img")].map((node) => {
      const box = node.getBoundingClientRect(),
        style = getComputedStyle(node);
      return {
        tag: node.tagName,
        text: node.textContent?.trim().slice(0, 100),
        box: box.toJSON(),
        margin: style.margin,
        padding: style.padding,
        font: style.font,
        color: style.color,
        background: style.backgroundColor,
      };
    }),
  );
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify(metrics, null, 2));
  await scope.screenshot({
    path: info.outputPath(`${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

for (const width of [1440, 390])
  test(`inspector headers, ownership badges and expanded content retain geometry at ${width}px`, async ({
    page,
    studio,
  }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 1000 });
    for (const model of Object.values(studio.response.snapshot.models))
      Object.assign(model, { resources: [...model.resources, ...resources(model.mode)] });
    const entities = Object.fromEntries(
      resources("dev")
        .filter((resource) => resource.id !== "resource:stylingNoSource")
        .map((resource) => [
          resource.id,
          {
            origin: resource.id,
            key: declaration,
            value:
              resource.id === groupId
                ? { ...declaration, file: "framework-config/shared/presentation.ts", line: 4 }
                : declaration,
          },
        ]),
    );
    Object.assign(studio.response.snapshot.source.entities, entities);

    const cases = [
      { id: "resource:stylingManaged", name: "managed", statuses: ["managed"] },
      {
        id: "framework-stack:DetachedPresentationStack",
        name: "unattached",
        statuses: ["managed", "unattached", "unattached"],
      },
      { id: inputId, name: "input", statuses: [] },
      { id: groupId, name: "group", statuses: [] },
      { id: "client-envfile", name: "client-environment", statuses: [] },
      { id: "envfile:dev", name: "missing-file", statuses: ["managed"] },
      { id: "resource:stylingNoSource", name: "missing-source", statuses: [] },
    ] as const;

    for (const item of cases) {
      await studio.goto(`/?select=${encodeURIComponent(item.id)}`);
      const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
      const header = inspector.locator('[data-slot="inspector-content"] > header');
      await expect(header).toBeVisible();
      await expect(header.locator("h2")).toHaveCount(1);
      expect(
        await header
          .locator("[data-resource-status]")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-resource-status"))),
      ).toEqual([...item.statuses]);
      const geometry = await header.evaluate((element) => {
        const title = element.querySelector("h2")!.getBoundingClientRect();
        return {
          header: element.getBoundingClientRect().toJSON(),
          title: title.toJSON(),
          badges: [...element.querySelectorAll("[data-resource-status]")].map((node) =>
            node.getBoundingClientRect().toJSON(),
          ),
          icons: [...element.querySelectorAll("h2 img")].map((node) =>
            node.getBoundingClientRect().toJSON(),
          ),
        };
      });
      for (const [index, badge] of geometry.badges.entries()) {
        expect(badge.top).toBeGreaterThanOrEqual(
          index ? geometry.badges[index - 1]!.bottom : geometry.title.bottom,
        );
        expect(badge.right).toBeLessThanOrEqual(geometry.header.right);
      }
      for (const icon of geometry.icons) expect(icon.width).toBe(24);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await capture(header, `${item.name}-header`, info);

      if (item.name === "unattached") {
        const summary = header.locator("summary").filter({ hasText: "About this resource" });
        await summary.focus();
        await page.keyboard.press("Enter");
        await expect(summary.locator("..")).toHaveAttribute("open", "");
        await expect(summary).toBeFocused();
        await capture(header, "unattached-expanded", info);
      }
      if (item.name === "group") {
        const entries = inspector.locator('[data-slot="input-group-entries"]');
        await expect(entries.getByRole("button", { name: "Add input", exact: true })).toBeVisible();
        await capture(entries, "group-entries", info);
      }
      if (item.name === "input")
        await capture(inspector.locator('[data-slot="resource-editor"]'), "input-settings", info);
      if (item.name === "client-environment") {
        const mapping = inspector.getByRole("button", {
          name: "Edit mapping for VITE_PRESENTATION",
          exact: true,
        });
        await mapping.focus();
        await page.keyboard.press("Enter");
        await expect(mapping).toHaveAttribute("aria-expanded", "true");
        await capture(
          inspector.locator('[data-slot="client-mapping-detail"]'),
          "client-mapping-expanded",
          info,
        );
        const summary = inspector.locator("summary").filter({ hasText: "File details" });
        await summary.focus();
        await page.keyboard.press("Space");
        await expect(summary.locator("..")).toHaveAttribute("open", "");
        await capture(summary.locator("../.."), "client-file-details", info);
      }
    }

    // The missing-file badge is shown in the environment island's entry list.
    await studio.goto("/?select=island%3Aenvironment");
    const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
    const entries = inspector.locator("summary").filter({ hasText: "Island entries" });
    await entries.focus();
    await page.keyboard.press("Enter");
    const list = entries.locator("../..");
    await expect(list.locator('[data-resource-status="missing"]')).toHaveText("Not generated");
    await expect(entries).toBeFocused();
    await studio.settle();
    await capture(list, "environment-entries-missing-status", info);
    expect(studio.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  });
