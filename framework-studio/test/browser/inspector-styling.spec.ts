import type { Locator, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { Mode, ModelResource } from "../../shared/model";
import { CLIENT_ENVIRONMENT_FILES } from "../../shared/client-environment";
import { location } from "./support/scenarios";
import { test, expect, assertAccessible } from "./support/test";

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

test("linked input sections retain gutters, private-value states and keyboard controls", async ({ page, studio }, info) => {
  test.setTimeout(90_000);
  const id = "resource:presentationSecret";
  const name = "PRESENTATION_ONLY_LONG_ENVIRONMENT_VARIABLE";
  for (const model of Object.values(studio.response.snapshot.models))
    Object.assign(model, { resources: [...model.resources, {
      id, path: ["presentationSecret"], kind: "secret", fromEnv: name, absent: false,
      modes: { dev: { present: true, required: false }, prod: { present: true, required: false } },
    }] });
  let state: "loading" | "error" | "missing" | "ready" = "loading";
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/resources/details", async (route, url) => {
    if (state === "loading") await pending;
    if (state === "error") { await route.fulfill({ status: 503, json: { error: "Fixture local file could not be read. Retry the value read." } }); return; }
    await route.fulfill({ json: {
      file: `cdk-app/.env.${url.searchParams.get("mode")}`,
      inputFile: { exists: state !== "missing", hash: "fixture-input-file" },
      configured: state !== "missing", value: state === "missing" ? "" : "presentation-only-fixture",
    } });
  });
  await studio.goto(`/?select=${encodeURIComponent(id)}`);
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const local = inspector.getByRole("region", { name: "Local value", exact: true });
  await expect(local.getByRole("status")).toHaveText("Reading local value…");
  state = "error"; release();
  await expect(local.getByRole("alert")).toContainText("could not be read");
  state = "missing";
  await local.getByRole("button", { name: "Retry value read" }).click();
  await expect(local.getByRole("button", { name: "Set up .env.dev" })).toBeVisible();
  await capture(local, "local-value-missing", info);
  state = "ready";
  await studio.goto(`/?select=${encodeURIComponent(id)}`);
  const value = local.getByRole("textbox", { name: `Value for ${name}` });
  await expect(value).toHaveAttribute("type", "password");
  for (const width of [1440, 1100, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await value.scrollIntoViewIfNeeded();
    const geometry = await local.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { box: box.toJSON(), overflow: element.scrollWidth > element.clientWidth,
        heading: element.querySelector("h3")!.getBoundingClientRect().toJSON(),
        mode: element.querySelector("[data-slot=local-input-mode]")!.getBoundingClientRect().toJSON(),
        input: element.querySelector("input")!.getBoundingClientRect().toJSON(),
        reveal: element.querySelector("[aria-pressed]")!.getBoundingClientRect().toJSON() };
    });
    expect(Math.round(geometry.heading.left - geometry.box.left)).toBe(20);
    expect(Math.round(geometry.box.right - geometry.mode.right)).toBe(20);
    expect(geometry.input.left).toBe(geometry.heading.left);
    expect(geometry.reveal.left - geometry.input.right).toBeGreaterThanOrEqual(8);
    expect(geometry.reveal.right).toBeLessThanOrEqual(geometry.box.right - 20);
    expect(geometry.overflow).toBe(false);
    // Each environment card keeps its name, checkboxes and default on one left edge.
    const cards = await inspector.locator('[data-slot="input-mode"]').evaluateAll(elements =>
      elements.map(element => ({
        name: element.querySelector("[data-slot=environment-name]")!.getBoundingClientRect().left,
        checks: [...element.querySelectorAll("input[type=checkbox]")].map(e => e.getBoundingClientRect().left),
        box: element.getBoundingClientRect().toJSON(),
      })),
    );
    expect(cards).toHaveLength(2);
    for (const card of cards) for (const left of card.checks) expect(Math.abs(left - card.name)).toBeLessThan(1);
    expect(cards[1]!.box.top >= cards[0]!.box.bottom || cards[1]!.box.left >= cards[0]!.box.right).toBe(true);
    await capture(local, `local-value-${width}`, info);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const reveal = local.getByRole("button", { name: `Reveal ${name}` });
  await reveal.focus(); await page.keyboard.press("Enter");
  await expect(value).toHaveValue("presentation-only-fixture");
  await expect(value).not.toHaveAttribute("type", "password");
  await page.keyboard.press("Enter");
  await expect(value).toHaveAttribute("type", "password");
  await value.fill("presentation-only-edited");
  await expect(local.getByRole("status").getByText("Unsaved change", { exact: true })).toBeVisible();
  await expect(inspector.getByRole("switch", { name: "Secret", exact: true })).toBeDisabled();
  await local.getByRole("button", { name: "Revert value" }).click();
  await expect(value).toHaveValue("presentation-only-fixture");
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await expect(local.getByText("Production file", { exact: true })).toBeVisible();
  await expect(local.getByRole("button", { name: "cdk-app/.env.prod" })).toBeVisible();
  await expect(value).toHaveAttribute("type", "password");
  await assertAccessible(page);
  expect(studio.requests.filter(request => request.method !== "GET")).toHaveLength(0);
});

test("long client mappings keep names, badges and actions aligned when expanded or filtered", async ({ page, studio }, info) => {
  test.setTimeout(90_000);
  const name = "VITE_PRESENTATION_VERY_LONG_API_GATEWAY_URL";
  for (const model of Object.values(studio.response.snapshot.models)) {
    const file = resources(model.mode).find(resource => resource.clientEnvironment)!;
    Object.assign(file.clientEnvironment!, { mappings: { [name]: { dev: { kind: "empty" }, prod: { kind: "empty" } }, VITE_SECOND_FIELD: { kind: "empty" } } });
    Object.assign(model, { resources: [...model.resources, file] });
  }
  await studio.goto("/?select=client-envfile");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const row = inspector.locator('[data-slot="client-environment-mappings"] > li').first();
  for (const width of [1440, 1100, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await row.scrollIntoViewIfNeeded();
    const geometry = await row.evaluate(element => {
      const header = element.querySelector('[data-slot="client-mapping-name"]')!;
      return { row: element.getBoundingClientRect().toJSON(), overflow: element.scrollWidth > element.clientWidth,
        name: header.querySelector("strong")!.getBoundingClientRect().toJSON(),
        badges: header.querySelector('[data-slot="environment-pills"]')!.getBoundingClientRect().toJSON(),
        actions: [...header.querySelectorAll("button")].map(e => e.getBoundingClientRect().toJSON()) };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.badges.left).toBe(geometry.name.left);
    expect(geometry.badges.top).toBeGreaterThanOrEqual(geometry.name.bottom);
    expect(geometry.actions[0]!.left).toBeGreaterThan(geometry.name.right);
    expect(geometry.actions[1]!.right).toBeLessThanOrEqual(geometry.row.right);
    await capture(row, `mapping-${width}`, info);
  }
  const expand = row.getByRole("button", { name: `Edit mapping for ${name}` });
  await expand.focus(); await page.keyboard.press("Enter");
  await expect(expand).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByRole("combobox", { name: `Source type for ${name} in Development` })).toBeVisible();
  await expect(row.getByRole("combobox", { name: `Source type for ${name} in Production` })).toBeVisible();
  await expect(row.getByRole("button", { name: `Reset mapping for ${name}` })).toBeDisabled();
  await capture(row, "mapping-expanded-320", info);
  await assertAccessible(page);
  await inspector.getByRole("searchbox", { name: "Search client mappings" }).fill("no-such-field");
  await expect(inspector.getByText("No matching fields or sources.")).toBeVisible();
  await inspector.getByRole("searchbox", { name: "Search client mappings" }).fill("");
  await expect(expand).toHaveAttribute("aria-expanded", "true");
  expect(studio.requests.filter(request => request.method !== "GET")).toHaveLength(0);
});

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
