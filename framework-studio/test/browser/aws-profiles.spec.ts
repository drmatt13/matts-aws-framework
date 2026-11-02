import { test, expect, assertAccessible } from "./support/test";

test.beforeEach(async ({ studio }) => {
  studio.reply("GET", "/api/deploy/profiles", async route => route.fulfill({ json: [
    { name: "dev", region: "us-east-1", kind: "sso" },
    { name: "production", region: "eu-west-1", kind: "sso" },
  ] }));
  studio.reply("GET", "/api/deploy/identity", async (route, url) => route.fulfill({ json: { ok: true, value: { context: {
    profile: url.searchParams.get("profile"), account: "123456789012", region: url.searchParams.get("profile") === "production" ? "eu-west-1" : "us-east-1",
    arn: "arn:aws:sts::123456789012:assumed-role/Developer/tester",
  } } } }));
});

for (const width of [1440, 320]) test(`mode buttons keep the open profile panel visible at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 800 });
  await studio.goto("/graphql");
  const development = page.getByRole("button", { name: "Development", exact: true });
  const production = page.getByRole("button", { name: "Production", exact: true });
  const panel = page.getByRole("dialog");
  const trigger = page.getByRole("button", { name: /AWS profile:/ });
  const select = page.getByRole("combobox", { name: "AWS profile", exact: true });
  await production.click();
  await expect(panel).toBeHidden();
  await development.click();
  await trigger.click();
  await select.selectOption("dev");
  await page.evaluate(() => {
    const panel = document.querySelector('[popover]')!;
    panel.setAttribute('data-close-count', '0');
    panel.addEventListener('toggle', event => {
      if ((event as ToggleEvent).newState === 'closed') panel.setAttribute('data-close-count', String(Number(panel.getAttribute('data-close-count')) + 1));
    });
  });
  await production.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading")).toHaveText("Production");
  await expect(select).toHaveValue("");
  await select.selectOption("production");
  await expect(panel).toContainText("eu-west-1");
  await development.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading")).toHaveText("Development");
  await expect(select).toHaveValue("dev");
  await expect(development).toBeFocused();
  await production.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(select).toHaveValue("production");
  await expect(panel).toHaveAttribute("data-close-count", "0");
  await trigger.click();
  await expect(panel).toBeHidden();
  await trigger.click();
  await page.getByRole("main").click({ position: { x: 8, y: 600 } });
  await expect(panel).toBeHidden();
});

test("mode associations survive navigation and reload, allow reuse, and clear independently", async ({ page, studio }) => {
  await studio.goto("/graphql");
  const trigger = () => page.getByRole("button", { name: /AWS profile:/ });
  const select = () => page.getByRole("combobox", { name: "AWS profile", exact: true });
  await trigger().focus();
  await page.keyboard.press("Enter");
  await expect(select()).toBeFocused();
  await select().selectOption("dev");
  await expect(page.getByRole("dialog")).toContainText("123456789012");
  await page.keyboard.press("Escape");
  await expect(trigger()).toBeFocused();
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await trigger().click();
  await expect(select()).toHaveValue("");
  await select().selectOption("production");
  await expect(page.getByRole("dialog")).toContainText("eu-west-1");
  await page.getByRole("heading", { name: "GraphQL", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "Map", exact: true }).click();
  await expect(trigger()).toHaveAccessibleName("Production AWS profile: production");
  await page.reload();
  await expect(trigger()).toHaveAccessibleName("Development AWS profile: dev");
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await trigger().click();
  await expect(select()).toHaveValue("production");
  await select().selectOption("dev");
  await select().selectOption("");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(trigger()).toHaveAccessibleName("Development AWS profile: dev");
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(studio.requests.some(request => /deploy\/(discover|status|overview)/.test(request.path))).toBe(false);
});

test("profile panel fits a phone, restores focus and passes accessibility checks", async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await studio.goto("/graphql");
  const trigger = page.getByRole("button", { name: /Development AWS profile:/ });
  await trigger.click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("dev");
  await expect(page.getByRole("dialog")).toContainText("Signed in as tester");
  const bounds = await page.getByRole("dialog").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("profile-phone.png") });
  await page.getByRole("button", { name: "Close AWS profile" }).click();
  await expect(trigger).toBeFocused();
});

test("loading, empty and read-error states recover by reopening or retrying", async ({ page, studio }) => {
  let resolve!: () => void;
  const waiting = new Promise<void>(done => { resolve = done; });
  let state = "loading";
  studio.reply("GET", "/api/deploy/profiles", async route => {
    if (state === "loading") await waiting;
    await route.fulfill(state === "error" ? { status: 500, json: { error: "Fixture read failed" } } : { json: state === "ready" ? [{ name: "dev", kind: "sso" }] : [] });
  });
  await studio.goto("/graphql");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Loading AWS profiles…");
  state = "empty"; resolve();
  await expect(page.getByRole("dialog")).toContainText("No AWS profiles on this machine");
  state = "error";
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture read failed");
  state = "ready";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "AWS profile" })).toBeEnabled();
});

test("choosing a previously selected profile automatically refreshes its account details", async ({ page, studio }) => {
  let developmentReads = 0;
  studio.reply("GET", "/api/deploy/identity", async (route, url) => {
    const profile = url.searchParams.get("profile");
    if (profile === "dev") developmentReads++;
    await route.fulfill({ json: { ok: true, value: { context: { profile, account: profile === "dev" && developmentReads > 1 ? "999999999999" : "123456789012", region: "us-east-1", arn: "arn:aws:iam::123456789012:user/tester" } } } });
  });
  await studio.goto("/graphql");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  const select = page.getByRole("combobox", { name: "AWS profile" });
  const panel = page.getByRole("dialog");
  await select.selectOption("dev");
  await expect(panel).toContainText("123456789012");
  await select.selectOption("production");
  await expect(panel).toContainText("123456789012");
  await select.selectOption("dev");
  await expect(panel).toContainText("999999999999");
  await expect(panel.getByRole("button", { name: /Refresh/ })).toHaveCount(0);
  await expect(panel).not.toContainText("Saved for");
  await expect(panel).not.toContainText("Each mode remembers");
});

for (const width of [1440, 320]) test(`profile configuration opens as a foreground placeholder modal at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 800 });
  await studio.goto("/graphql");
  const trigger = page.getByRole("button", { name: /Development AWS profile:/ });
  await trigger.click();
  await page.getByRole("button", { name: "Configure AWS profiles" }).click();
  const modal = page.getByRole("dialog", { name: "AWS profile configuration", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Placeholder");
  expect(await modal.evaluate(element => element.matches(":modal"))).toBe(true);
  const close = modal.getByRole("button", { name: "Close AWS profile configuration", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Production", exact: true })).not.toBeFocused();
  await assertAccessible(page);
  const bounds = await modal.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  await page.screenshot({ path: testInfo.outputPath("configuration-placeholder.png") });
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("button", { name: "Configure AWS profiles" }).click();
  await close.click();
  await expect(modal).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
});

test("unavailable saved profiles never fall back to another account", async ({ page, studio }) => {
  await studio.goto("/graphql");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("dev");
  await page.keyboard.press("Escape");
  studio.reply("GET", "/api/deploy/profiles", async route => route.fulfill({ json: [{ name: "production", kind: "sso" }] }));
  await page.reload();
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await expect(page.getByRole("alert")).toContainText("saved profile “dev” is unavailable");
  await expect(page.getByRole("combobox", { name: "AWS profile" })).toHaveValue("dev");
  await expect(page.getByRole("dialog")).not.toContainText("123456789012");
});

test("identity errors clear on profile change without carrying over account details", async ({ page, studio }) => {
  studio.reply("GET", "/api/deploy/identity", async (route, url) => route.fulfill({ json: url.searchParams.get("profile") === "dev"
    ? { ok: false, problem: { kind: "expired", message: "Sign in to your AWS CLI profile again." } }
    : { ok: true, value: { context: { profile: "production", account: "999999999999", region: "eu-west-1", arn: "arn:aws:iam::999999999999:user/operator" } } } }));
  await studio.goto("/graphql");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  const select = page.getByRole("combobox", { name: "AWS profile" });
  await select.selectOption("dev");
  await expect(page.getByRole("alert")).toContainText("Sign in");
  await select.selectOption("production");
  await expect(page.getByRole("dialog")).toContainText("999999999999");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("unavailable browser storage preserves both choices for the session", async ({ context, page, studio }) => {
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Storage disabled", "SecurityError"); };
  });
  await studio.goto("/graphql");
  const trigger = () => page.getByRole("button", { name: /AWS profile:/ });
  await trigger().click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("dev");
  await expect(page.getByRole("alert")).toContainText("kept for this session");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await trigger().click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("production");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(trigger()).toHaveAccessibleName("Development AWS profile: dev");
});

test("another tab's mode association updates without losing the current choice", async ({ context, page, studio }) => {
  await studio.goto("/graphql");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("dev");
  await page.keyboard.press("Escape");
  const other = await context.newPage();
  await other.goto("/graphql");
  await other.getByRole("button", { name: "Production", exact: true }).click();
  await other.getByRole("button", { name: /Production AWS profile:/ }).click();
  await other.getByRole("combobox", { name: "AWS profile" }).selectOption("production");
  await expect(page.getByRole("button", { name: /Development AWS profile:/ })).toHaveAccessibleName("Development AWS profile: dev");
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await expect(page.getByRole("button", { name: /Production AWS profile:/ })).toHaveAccessibleName("Production AWS profile: production");
  await other.close();
});
