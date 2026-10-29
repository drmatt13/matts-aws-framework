import type { Locator, Page, TestInfo } from "@playwright/test";
import type { CognitoOperation } from "../../shared/identity-operations";
import { test, expect } from "./support/test";
import { discovery, identity } from "./support/scenarios";
import { cognito, context, deployment, dnsDiscovery, dnsReview, domainHealth, domains, expandedOverview, frontendReview, inventory, lifecyclePlan, longArn, operationReview, policySources, pools, simulation, teardown } from "./support/deep-scenarios";

async function expandAll(page: Page, scope: Locator = page.locator("main")) {
  for (let count = 0; count < 60; count++) {
    const details = scope.locator('details:visible:not([open]):not(:has(>summary[aria-haspopup="menu"]))').first();
    if (!await details.count()) return;
    await details.locator(":scope > summary").click();
  }
  throw new Error("Disclosure expansion did not finish");
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && !element.closest("[hidden]") && getComputedStyle(element).visibility !== "hidden"; };
    const controls = [...document.querySelectorAll<HTMLInputElement>("input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea")].filter(visible).map(element => {
      const box = element.getBoundingClientRect(), label = element.closest("label");
      return { name: element.getAttribute("aria-label") ?? label?.textContent?.trim() ?? element.id, x: box.x, right: box.right, width: box.width, labelWidth: label?.getBoundingClientRect().width };
    });
    const labels = [...document.querySelectorAll("label")].filter(visible).flatMap(label => {
      const node = [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      if (!node || !/^(Profile|Deployment|Region|Action|Username|Email|Given name|Family name|Group|Group description)$/.test(node.textContent!.trim())) return [];
      const range = document.createRange(); range.selectNodeContents(node); const box = range.getBoundingClientRect();
      return [{ text: node.textContent!.trim(), width: box.width, height: box.height, lineHeight: parseFloat(getComputedStyle(label).lineHeight) }];
    });
    const cards = [...document.querySelectorAll<HTMLElement>('[data-ui="document-card"],dialog[open]')].filter(visible).map(element => ({ name: element.getAttribute("aria-label") ?? element.querySelector("h2")?.textContent ?? "dialog", width: element.clientWidth, contentWidth: element.scrollWidth }));
    const buttons = [...document.querySelectorAll("button")].filter(visible).map(button => { const box = button.getBoundingClientRect(); return { name: button.getAttribute("aria-label") ?? button.textContent?.trim(), x: box.x, right: box.right }; });
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, controls, labels, cards, buttons, links: [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(visible).map(link => ({ text: link.textContent?.trim(), href: link.href })) };
  });
}

async function capture(page: Page, info: TestInfo, name: string, target?: Locator) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const values = await geometry(page);
  await info.attach(`${name}-geometry`, { body: JSON.stringify(values, null, 2), contentType: "application/json" });
  expect(values.documentWidth, `document overflow in ${name}`).toBeLessThanOrEqual(values.viewport);
  for (const card of values.cards) expect(card.contentWidth, `${name}: ${card.name} must contain its content`).toBeLessThanOrEqual(card.width + 1);
  for (const button of values.buttons) { expect(button.x, `${name}: ${button.name} left edge`).toBeGreaterThanOrEqual(-1); expect(button.right, `${name}: ${button.name} right edge`).toBeLessThanOrEqual(values.viewport + 1); }
  for (const control of values.controls) {
    expect(control.width, `${name}: ${control.name} width`).toBeGreaterThanOrEqual(Math.min(100, values.viewport - 64));
    expect(control.x, `${name}: ${control.name} left edge`).toBeGreaterThanOrEqual(-1);
    expect(control.right, `${name}: ${control.name} right edge`).toBeLessThanOrEqual(values.viewport + 1);
    if (control.labelWidth) expect(control.labelWidth, `${name}: ${control.name} label container`).toBeGreaterThanOrEqual(control.width - 1);
  }
  for (const label of values.labels) expect(label.height, `${name}: ${label.text} must remain one readable line`).toBeLessThanOrEqual(label.lineHeight * 1.25);
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await info.attach(name, { path: file, contentType: "image/png" });
}

async function primaryFooter(page: Page, button: Locator) {
  const bounds = await button.boundingBox();
  expect(bounds).not.toBeNull();
  if (page.viewportSize()!.width > 420) expect(bounds!.width).toBeGreaterThanOrEqual(110);
  else {
    const available = await button.evaluate(element => {
      const footer = element.closest("footer")!;
      const style = getComputedStyle(footer);
      return footer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    expect(bounds!.width).toBeCloseTo(available, 0);
  }
}

async function readableTable(region: Locator) {
  await expect(region).toHaveAttribute("tabindex", "0");
  const values = await region.evaluate(element => {
    const table = element.querySelector("table")!;
    return { region: element.getBoundingClientRect().width, table: table.getBoundingClientRect().width, scroll: element.scrollWidth,
      headings: [...table.querySelectorAll("thead th")].map(heading => ({ text: heading.textContent, width: heading.getBoundingClientRect().width, whiteSpace: getComputedStyle(heading).whiteSpace })) };
  });
  expect(values.table).toBeGreaterThanOrEqual(720);
  for (const heading of values.headings) { expect(heading.width, heading.text ?? "column").toBeGreaterThanOrEqual(80); expect(heading.whiteSpace).toBe("nowrap"); }
  if (values.region < 720) expect(values.scroll).toBeGreaterThan(values.region);
  await region.focus();
  await expect(region).toBeFocused();
  if (values.region < 720) {
    await region.press("ArrowRight");
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await region.press("ArrowLeft");
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBe(0);
  }
}

for (const width of [1440, 390]) test.describe(`expanded pages ${width}px`, () => {
  test.use({ viewport: { width, height: 1000 } });

  test("Cognito observed subsections, retention and both federation forms remain readable", async ({ page, studio }, info) => {
    studio.reply("GET", "/api/identity/cognito", route => route.fulfill({ json: cognito }));
    studio.reply("GET", "/api/identity/pools", route => route.fulfill({ json: pools }));
    studio.reply("GET", "/api/deploy/teardown", route => route.fulfill({ json: { ok: true, value: teardown } }));
    studio.reply("POST", "/api/stateful-resources/inventory", route => route.fulfill({ json: inventory }));
    studio.reply("POST", "/api/stateful-resources/retention/plan", route => route.fulfill({ json: lifecyclePlan }));
    studio.reply("POST", "/api/stateful-resources/reference/plan", route => route.fulfill({ json: lifecyclePlan }));
    await studio.goto("/cognito");
    await capture(page, info, "cognito-inspection-toolbar");
    await page.getByRole("button", { name: "Inspect authentication", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Fixture application users", exact: true })).toBeVisible();
    await expandAll(page);
    await readableTable(page.getByRole("region", { name: "Cognito users", exact: true }));
    await readableTable(page.getByRole("region", { name: "Cognito groups", exact: true }).first());
    await capture(page, info, "cognito-observed-users", page.getByRole("heading", { name: "Users", exact: true }));
    await page.getByRole("textbox", { name: "Search Cognito users", exact: true }).fill("fixture");
    await page.getByRole("button", { name: "Search users", exact: true }).click();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.getByRole("button", { name: "Inspect deployed protection and inventory", exact: true }).click();
    await expect(page.getByRole("button", { name: "us-east-1_fixture-retained", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "us-east-1_fixture-retained", exact: true }).click();
    await page.getByRole("textbox", { name: "Retained Cognito app client ID", exact: true }).fill("fixture-existing-client");
    await capture(page, info, "cognito-retained-resource-form", page.getByRole("textbox", { name: "Retained Cognito app client ID" }));
    await page.getByRole("button", { name: "Inspect and review reference source", exact: true }).click();
    const lifecycle = page.getByRole("dialog", { name: "Review lifecycle source", exact: true });
    await expect(lifecycle).toBeVisible();
    await capture(page, info, "cognito-reference-source-review");
    await lifecycle.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("combobox", { name: "Cognito User Pool retention policy", exact: true }).selectOption("retain");
    await expect(lifecycle).toBeVisible();
    await capture(page, info, "cognito-retention-source-review");
    await lifecycle.getByRole("button", { name: "Cancel", exact: true }).click();
    for (const section of ["Identity Pools", "Providers", "Permissions & RBAC"]) {
      await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: section, exact: true }).click();
      await expandAll(page);
      await capture(page, info, `cognito-${section.replace(/[^a-z]+/gi, "-").toLowerCase()}`, page.getByRole("heading", { name: section, exact: true }).first());
    }
    await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: "User Pools", exact: true }).click();
    for (const [link, heading] of [["Set up federation", "Providers"], ["Connect AWS access", "Identity Pools"], ["Inspect permissions", "Permissions & RBAC"]]) {
      await page.getByRole("link", { name: link, exact: true }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
      await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: "User Pools", exact: true }).click();
    }
    await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: "Providers", exact: true }).click();
    await page.getByRole("button", { name: "Add federation provider", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await capture(page, info, "federation-oidc-form");
    await capture(page, info, "federation-oidc-claims", dialog.getByLabel("Provider verified-email claim", { exact: true }));
    await dialog.getByLabel("Federation type", { exact: true }).selectOption("saml");
    await expect(dialog.getByLabel("SAML metadata URL", { exact: true })).toBeVisible();
    await capture(page, info, "federation-saml-form");
    await capture(page, info, "federation-saml-claims", dialog.getByLabel("Provider verified-email claim", { exact: true }));
    await dialog.getByRole("button", { name: "Cancel creation", exact: true }).click();
    await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: "Identity Pools", exact: true }).click();
    await page.getByRole("button", { name: "Create identity pool source", exact: true }).click();
    await expect(dialog).toBeVisible();
    await capture(page, info, "identity-pool-creation-form");
    await dialog.getByRole("button", { name: "Cancel creation", exact: true }).click();
    await page.getByRole("navigation", { name: "Cognito sections" }).getByRole("link", { name: "User Pools", exact: true }).click();
    studio.reply("GET", "/api/identity/cognito", route => route.fulfill({ status: 500, json: { error: "Fixture observation unavailable; previous metadata is retained." } }));
    await page.getByRole("button", { name: "Inspect authentication", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Previous metadata remains visible" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fixture application users", exact: true })).toBeVisible();
    await capture(page, info, "cognito-inspection-error-retains-metadata", page.getByRole("button", { name: "Inspect authentication", exact: true }));
    await page.getByRole("group", { name: "Source environment", exact: true }).getByRole("button", { name: "Production", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Fixture application users", exact: true })).toHaveCount(0);
    await capture(page, info, "cognito-production-context");
    expect(studio.requests.filter(request => /\/(apply|operations)$/.test(request.path) && request.method === "POST")).toHaveLength(0);
  });

  test("all six Cognito management actions and production approval stay bounded", async ({ page, studio }, info) => {
    studio.reply("POST", "/api/identity/operations/review", route => route.fulfill({ json: operationReview((route.request().postDataJSON() as { operation: CognitoOperation }).operation) }));
    await studio.goto("/cognito");
    await page.getByRole("group", { name: "Source environment", exact: true }).getByRole("button", { name: "Production", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Identity deployment", exact: true })).toHaveValue("browser-prod");
    const management = page.getByRole("region", { name: "Cognito user and group management", exact: true });
    for (const action of ["create-user", "create-group", "add-to-group", "remove-from-group", "enable-user", "disable-user"]) {
      await management.getByRole("combobox", { name: "Cognito management action" }).selectOption(action);
      for (const field of ["username", "email", "given name", "family name", "group", "group description"]) {
        const input = management.getByRole("textbox", { name: `Cognito management ${field}`, exact: true });
        if (await input.count()) await input.fill(field === "email" ? "fixture@example.invalid" : "Fixture subject");
      }
      await capture(page, info, `cognito-${action}-form`, management.getByRole("combobox", { name: "Cognito management action" }));
      await management.getByRole("button", { name: "Review Cognito operation", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Approve Cognito operation", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Apply exact Cognito operation", exact: true })).toBeDisabled();
      await dialog.getByRole("textbox", { name: "Cognito operation confirmation", exact: true }).fill("Approve fixture operation");
      await dialog.getByRole("textbox", { name: "Production Cognito operation authorization", exact: true }).fill("Authorize fixture production pool");
      await expect(dialog.getByRole("button", { name: "Apply exact Cognito operation", exact: true })).toBeEnabled();
      await primaryFooter(page, dialog.getByRole("button", { name: "Apply exact Cognito operation", exact: true }));
      await capture(page, info, `cognito-${action}-approval`);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    expect(studio.requests.filter(request => /operations\/apply/.test(request.path))).toHaveLength(0);
  });

  test("policy statements, simulation results and unsaved-edit dialog preserve usable widths", async ({ page, studio }, info) => {
    studio.reply("GET", "/api/identity-policy/sources", route => route.fulfill({ json: { revision: "fixture-policy-revision", sources: policySources } }));
    studio.reply("POST", "/api/identity-policy/simulate", route => route.fulfill({ json: simulation }));
    await studio.goto("/cognito/permissions");
    await expect(page.getByRole("textbox", { name: "Policy resources 1", exact: true })).toBeVisible();
    await expandAll(page);
    await page.getByRole("textbox", { name: "Expected simulation account", exact: true }).fill(context.account);
    await page.getByRole("textbox", { name: "Simulation resources", exact: true }).fill(longArn);
    await page.getByRole("button", { name: "Simulate saved policy", exact: true }).click();
    await expect(page.getByRole("cell", { name: "implicitDeny", exact: true })).toBeVisible();
    await readableTable(page.getByRole("region", { name: "IAM simulation results", exact: true }));
    await capture(page, info, "permission-simulation-context", page.getByRole("button", { name: "Simulate saved policy", exact: true }));
    await capture(page, info, "permission-simulation-results", page.getByRole("cell", { name: "implicitDeny", exact: true }));
    await page.getByRole("button", { name: "Add explicit Deny statement", exact: true }).click();
    await page.getByRole("textbox", { name: "Policy resources 2", exact: true }).fill(longArn);
    await capture(page, info, "permission-edited-statements", page.getByRole("textbox", { name: "Policy resources 2", exact: true }));
    await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "Domains", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Unsaved policy edits", exact: true });
    await expect(dialog).toBeVisible();
    await capture(page, info, "permission-departure-dialog");
    await dialog.getByRole("button", { name: "Keep editing policy", exact: true }).click();
    await page.getByRole("button", { name: "Discard local policy edits", exact: true }).click();
    expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
  });

  test("Domains evidence, live health, managed-zone selection and DNS review remain bounded", async ({ page, studio }, info) => {
    studio.reply("GET", "/api/identity/domains", route => route.fulfill({ json: domains }));
    studio.reply("GET", "/api/identity/domain-health", route => route.fulfill({ json: domainHealth }));
    studio.reply("GET", "/api/identity/domain-dns", route => route.fulfill({ json: dnsDiscovery }));
    studio.reply("POST", "/api/identity/domain-dns/review", route => route.fulfill({ json: dnsReview }));
    studio.reply("GET", "/api/identity/source", route => route.fulfill({ json: { ...identity("prod"), inputs: { USE_COGNITO_CUSTOM_DOMAIN: "false", USE_FRONTEND_CUSTOM_DOMAIN: "true", FRONTEND_URL: "https://app.example.invalid", FRONTEND_CLOUDFRONT_CERTIFICATE_ARN: domains.certificates[0]!.arn } } }));
    await studio.goto("/domains");
    await capture(page, info, "domains-inspection-toolbar");
    await page.getByRole("button", { name: "Inspect deployed settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Frontend certificate · ISSUED", exact: true })).toBeVisible();
    await capture(page, info, "domains-certificate-and-dns-evidence", page.getByRole("heading", { name: "Frontend certificate · ISSUED", exact: true }));
    await page.getByRole("button", { name: "Inspect live DNS / TLS / HTTP", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Observed app.example.invalid", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Discover managed DNS zones", exact: true }).click();
    await page.getByRole("combobox", { name: "Managed DNS zone", exact: true }).selectOption("ZFIXTURE");
    await capture(page, info, "domains-live-health-and-zones", page.getByRole("heading", { name: "Observed app.example.invalid", exact: true }));
    await page.getByRole("button", { name: "Review exact production DNS change", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Review production DNS routing", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Confirm exact production DNS change", exact: true }).fill(dnsReview.confirmation);
    await expect(dialog.getByRole("button", { name: "Apply this production DNS change", exact: true })).toBeEnabled();
    await primaryFooter(page, dialog.getByRole("button", { name: "Apply this production DNS change", exact: true }));
    await capture(page, info, "domains-exact-dns-review");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("combobox", { name: "Domain operation purpose", exact: true }).selectOption("cognito");
    await expect(page.getByRole("heading", { name: "Observed app.example.invalid", exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "FRONTEND_URL", exact: true }).fill("http://invalid.example.invalid");
    await expect(page.getByRole("alert").filter({ hasText: "FRONTEND_URL:" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspect live DNS / TLS / HTTP", exact: true })).toBeDisabled();
    await capture(page, info, "domains-invalid-source-draft", page.getByRole("textbox", { name: "FRONTEND_URL", exact: true }));
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "FRONTEND_URL", exact: true })).toHaveValue("https://app.example.invalid");
    await expect(page.getByRole("button", { name: "Inspect live DNS / TLS / HTTP", exact: true })).toBeEnabled();
    expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
  });

  test("Deploy expanded publication settings, identity review, actions and deletion review remain bounded", async ({ page, studio }, info) => {
    const observed = { ...discovery(), deployments: [deployment], targets: discovery().targets.map(target => ({ ...target, status: target.name === "browser-dev" ? "deployed" as const : target.status })) };
    studio.reply("GET", "/api/deploy/discover", route => route.fulfill({ json: { ok: true, value: observed } }));
    studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: expandedOverview() }));
    studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true, value: { ...observed, deployment: url.searchParams.get("deployment"), detail: { ...deployment, events: [], changeSets: [] } } } }));
    studio.reply("GET", "/api/deploy/teardown", route => route.fulfill({ json: { ok: true, value: teardown } }));
    studio.reply("GET", "/api/deploy/local/logs", route => route.fulfill({ json: { text: "Fixture service ready\nA long fixture log line remains internally scrollable: " + "fixture ".repeat(80) } }));
    studio.reply("GET", "/api/deploy/jobs/fixture-completed-job/log", route => route.fulfill({ json: { job: expandedOverview().jobs[0], lines: [{ seq: 1, at: context.observedAt, stream: "info", text: "Fixture template comparison finished without mutations." }] } }));
    studio.reply("POST", "/api/frontend-release/build", route => route.fulfill({ json: frontendReview }));
    studio.reply("POST", "/api/frontend-release/settings/review", route => route.fulfill({ json: { id: "fixture-settings-review", file: "framework-config/frontend-release.json", before: "{}", after: JSON.stringify({ buildScript: "fixture-build" }, null, 2) } }));
    studio.reply("POST", "/api/frontend-release/identities/review", route => route.fulfill({ json: { id: "fixture-identity-review", mode: "prod", name: "fixture-staging", warnings: ["A new identity does not rename or adopt an existing deployment."], changes: [{ file: "cdk-app/cdk.json", before: "{}", after: '{"fixture-staging":{"mode":"prod"}}' }] } }));
    await studio.goto("/deploy");
    await expect(page.getByRole("heading", { name: /browser-dev/ }).first()).toBeVisible();
    await expandAll(page);
    await page.getByTitle("Logs of fixture-service", { exact: true }).click();
    const logs = page.getByRole("dialog", { name: /fixture-service/ });
    await expect(logs).toBeVisible();
    await capture(page, info, "deploy-local-service-logs");
    await logs.getByRole("button", { name: "Close", exact: true }).click();
    await capture(page, info, "deploy-expanded-identities", page.getByText("Development & production deployment names", { exact: true }));
    const identities = page.locator("details").filter({ has: page.locator("summary", { hasText: /^Development & production deployment names$/ }) }).first();
    await identities.getByRole("combobox", { name: "Environment", exact: true }).selectOption("prod");
    await identities.getByLabel("New deployment name", { exact: true }).fill("fixture-staging");
    await identities.getByRole("button", { name: "Review new deployment source", exact: true }).click();
    await expect(page.getByRole("region", { name: "Deployment identity source review" })).toBeVisible();
    await capture(page, info, "deploy-new-identity-review", page.getByRole("region", { name: "Deployment identity source review" }));
    await page.getByRole("button", { name: "Build & review release", exact: true }).click();
    await expect(page.getByRole("region", { name: "Frontend publication review", exact: true })).toBeVisible();
    await expandAll(page);
    await page.getByRole("textbox", { name: "Frontend publication approval", exact: true }).fill("Publish browser-dev to fixture-public-client-assets");
    await expect(page.getByRole("button", { name: "Publish assets & request invalidation", exact: true })).toBeEnabled();
    await capture(page, info, "deploy-frontend-publication-review", page.getByRole("heading", { name: "Review frontend publication", exact: true }));
    await capture(page, info, "deploy-frontend-publication-approval", page.getByRole("textbox", { name: "Frontend publication approval", exact: true }));
    await page.getByLabel("Build script", { exact: true }).fill("fixture-build");
    await page.getByRole("button", { name: "Review settings source", exact: true }).click();
    await capture(page, info, "deploy-frontend-settings-source", page.getByRole("region", { name: "Frontend settings source review", exact: true }));
    const more = page.locator('summary[aria-label="More actions"]');
    await more.click();
    await capture(page, info, "deploy-more-actions");
    await more.press("ArrowDown");
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: "Delete deployment…", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await more.click();
    await page.getByRole("menuitem", { name: "Delete deployment…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /^Delete browser-dev/ });
    await expect(dialog).toBeVisible();
    await expandAll(page, dialog);
    await dialog.getByRole("textbox", { name: "Type browser-dev to delete it", exact: true }).fill("browser-dev");
    await expect(dialog.getByRole("button", { name: "Delete browser-dev", exact: true })).toBeEnabled();
    await primaryFooter(page, dialog.getByRole("button", { name: "Delete browser-dev", exact: true }));
    await capture(page, info, "deploy-deletion-review");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: /^Activity/ }).click();
    await expect(page.getByLabel("Log", { exact: true })).toContainText("Fixture template comparison");
    await capture(page, info, "deploy-activity-log");
    expect(studio.requests.filter(request => /\/(apply|publish|operations)$/.test(request.path) && request.method === "POST")).toHaveLength(0);
  });

  test("WebSocket connected, invalid JSON, long payload and expanded message states remain usable", async ({ page, studio }, info) => {
    await studio.goto("/websockets");
    for (const name of ["Local", "AWS"]) {
      const panel = page.getByRole("region", { name, exact: true });
      await panel.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(panel.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
      await panel.getByRole("textbox", { name: "Send payload", exact: true }).fill("{invalid");
      await expect(panel.getByRole("button", { name: `Send payload to ${name}`, exact: true })).toBeDisabled();
      await panel.getByRole("textbox", { name: "Send payload", exact: true }).fill(JSON.stringify({ action: "fixture", message: "Long fixture value ".repeat(80), items: [1, 2, 3] }, null, 2));
      await panel.getByRole("button", { name: `Send payload to ${name}`, exact: true }).click();
      await expect(panel.getByRole("log")).toContainText("1 item");
      await panel.getByRole("log").locator(".collapsed-icon:visible").first().click();
      await capture(page, info, `websocket-${name.toLowerCase()}-connected-long-message`, panel);
      await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
      await expect(panel.getByRole("log")).toContainText("Disconnected from WebSocket");
    }
    expect(studio.sockets).toHaveLength(2);
    await capture(page, info, "websocket-disconnected-with-history");
  });

  test("WebSocket settings loading and failure recover with a manually entered fixture URL", async ({ page, studio }, info) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    studio.reply("GET", "/api/websockets/defaults", async route => { await pending; await route.fulfill({ status: 500, json: { error: "Fixture settings unavailable; enter a known endpoint." } }); });
    await page.goto("/websockets");
    await expect(page.getByRole("status").filter({ hasText: "Reading the local WebSocket settings" })).toBeVisible();
    await capture(page, info, "websocket-settings-loading");
    release();
    await expect(page.getByRole("alert")).toContainText("Fixture settings unavailable");
    const local = page.getByRole("region", { name: "Local", exact: true });
    await expect(local.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
    await capture(page, info, "websocket-settings-error");
    await local.getByRole("textbox", { name: "Local connection URL", exact: true }).fill("ws://studio-fixture.invalid/manual-recovery");
    await local.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(local.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await capture(page, info, "websocket-manual-recovery", local);
    await local.getByRole("button", { name: "Disconnect", exact: true }).click();
  });
});
