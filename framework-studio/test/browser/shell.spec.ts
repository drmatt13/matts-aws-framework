import { test, expect, assertAccessible } from "./support/test";
import { writeFile } from "node:fs/promises";

const destinations = [
  { name: "Map", path: "/", ready: "Search isometric map" },
  { name: "Database", path: "/database", ready: "Database workspace" },
  { name: "Deploy", path: "/deploy", ready: "AWS profile" },
  { name: "Cognito", path: "/cognito", ready: "Cognito sections" },
  { name: "Domains", path: "/domains", ready: "DNS / Domains" },
  { name: "WebSockets", path: "/websockets", ready: "WebSockets" },
] as const;

test("primary destinations preserve shared navigation and source context", async ({ page, studio }) => {
  await studio.goto();
  const navigation = page.getByRole("navigation", { name: "Views", exact: true });
  await expect(navigation.getByRole("link")).toHaveText(["Map", "Database", "Deploy", "GraphQL", "Cognito", "Domains", "WebSockets"]);
  for (const { name, path: pathname } of [...destinations, { name: "GraphQL", path: "/graphql" }]) {
    await navigation.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${pathname === "/" ? "/" : pathname}$`));
    await expect(page.getByRole("group", { name: "Source environment", exact: true })).toHaveCount(1);
    await expect(navigation.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
    if (name === "GraphQL") await expect(page.getByRole("heading", { name: "GraphQL", exact: true })).toBeVisible();
    await studio.settle();
    expect(await page.evaluate(() => (window as unknown as { __studioBrowserEvents: { active(): number } }).__studioBrowserEvents.active())).toBe(1);
  }
  await assertAccessible(page);
});

for (const { name, path: pathname } of destinations) test(`baseline ${name} desktop`, async ({ page, studio }, testInfo) => {
  await studio.goto(pathname);
  if (name === "Map") await expect(page.getByRole("searchbox", { name: "Search isometric map" })).toBeVisible();
  if (name === "Database") await expect(page.getByRole("textbox", { name: "Prisma schema source" })).toBeVisible();
  if (name === "Deploy") await expect(page.getByRole("button", { name: /Refresh/ }).first()).toBeVisible();
  if (name === "Cognito") await expect(page.getByRole("navigation", { name: "Cognito sections" })).toBeVisible();
  if (name === "Domains") await expect(page.getByRole("heading", { name: "DNS / Domains" })).toBeVisible();
  if (name === "WebSockets") await expect(page.getByRole("button", { name: /^Connect/ }).first()).toBeVisible();
  await studio.settle();
  const metrics = await page.evaluate(() => [...document.querySelectorAll("body,header,nav,h1,h2,input,select,textarea,button")].filter(element => element.getBoundingClientRect().width && element.getBoundingClientRect().height).map(element => {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { tag: element.tagName, name: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 70), x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      font: style.font, color: style.color, background: style.backgroundColor, padding: style.padding, margin: style.margin, border: style.border, display: style.display, gap: style.gap };
  }));
  await writeFile(testInfo.outputPath("layout-metrics.json"), JSON.stringify(metrics, null, 2));
  await expect(page).toHaveScreenshot(`${name.toLowerCase()}-desktop.png`, { fullPage: true });
});

test("narrow navigation wraps without horizontal document overflow and reveals keyboard focus", async ({ page, studio }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await studio.goto();
  const nav = page.getByRole("navigation", { name: "Views", exact: true });
  await nav.getByRole("link", { name: "WebSockets", exact: true }).focus();
  await expect(nav.getByRole("link", { name: "WebSockets", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot("map-320.png", { fullPage: true });
});

test("loading and error recovery are contained and keyboard actionable", async ({ page, studio }) => {
  let failed = true;
  studio.reply("GET", "/api/snapshot", route => route.fulfill(failed ? { status: 500, json: { error: "Fixture snapshot unavailable" } } : { json: studio.response }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Fixture snapshot unavailable");
  failed = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Views", exact: true })).toBeVisible();
});

test("shell and map accessibility", async ({ page, studio }) => {
  await studio.goto();
  await assertAccessible(page);
});

test("initial loading remains visible until a snapshot arrives", async ({ page, studio }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/snapshot", async route => { await pending; await route.fulfill({ json: studio.response }); });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("Evaluating the repository");
  release();
  await expect(page.getByRole("navigation", { name: "Views", exact: true })).toBeVisible();
});

test("empty graph retains source navigation and a contained explanation", async ({ page, studio }) => {
  Object.assign(studio.response.snapshot.models.dev, { targets: [], resources: [], routes: [], edges: [] });
  await studio.goto();
  await expect(page.getByText(/The development graph did not load/)).toBeVisible();
  await page.getByRole("group", { name: "Source environment" }).getByRole("button", { name: "Production" }).click();
  await expect(page.getByRole("searchbox", { name: "Search isometric map" })).toBeVisible();
});
