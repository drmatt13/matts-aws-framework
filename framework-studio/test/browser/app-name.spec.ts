import { test, expect, assertAccessible } from "./support/test";

const appId = "5b7e3c1a-9d2f-4e6b-8a1c-3f0d2e9b7a64";
const view = {
  name: "studio-fixture",
  appId,
  stages: [{ stage: "dev", mode: "dev", implicit: true }, { stage: "prod", mode: "prod", account: "111122223333" }],
  hash: "fixture-hash",
};
const change = { file: "cdk-app/cdk.json", before: '{\n  "framework:app": "studio-fixture"\n}', after: '{\n  "framework:app": "acme"\n}' };
const deployedReview = {
  id: "review-deployed",
  from: "studio-fixture",
  name: "acme",
  rows: [
    { stage: "dev", mode: "dev", before: "studio-fixture-dev", after: "acme-dev", outcome: "follows", check: "absent" },
    { stage: "prod", mode: "prod", before: "studio-fixture-prod", after: "studio-fixture-prod", outcome: "keeps", check: "deployed", deployed: "studio-fixture-prod" },
  ],
  warnings: ["Applying edits cdk-app/cdk.json only; nothing is deployed."],
  change,
};
const uncheckedReview = {
  ...deployedReview,
  id: "review-unchecked",
  rows: [
    deployedReview.rows[0],
    { stage: "prod", mode: "prod", before: "studio-fixture-prod", after: "acme-prod", outcome: "follows", check: "unknown", reason: "No Production AWS profile is selected." },
  ],
  warnings: ["If production is already deployed, deploying acme-prod stops and offers to keep its name.", "Applying edits cdk-app/cdk.json only; nothing is deployed."],
};

test("the navbar names the app and reviews a rename against what AWS holds before writing cdk.json", async ({ page, studio }) => {
  const reviews: unknown[] = [];
  let applied = false;
  studio.reply("GET", "/api/app-name", (route) => route.fulfill({ json: view }));
  studio.reply("POST", "/api/app-name/review", (route) => {
    reviews.push(route.request().postDataJSON());
    return route.fulfill({ json: deployedReview });
  });
  studio.reply("POST", "/api/app-name/apply", (route) => {
    applied = true;
    return route.fulfill({ json: { name: "acme" } });
  });
  await studio.goto("/graphql");
  const trigger = page.getByRole("button", { name: "App name: studio-fixture. Rename", exact: true });
  await trigger.click();
  const editor = page.getByRole("dialog", { name: "studio-fixture" });
  const deployments = editor.getByRole("list", { name: "Deployments" });
  await expect(deployments).toContainText("studio-fixture-dev");
  // Nothing is claimed about AWS before a review has looked.
  await expect(deployments.locator("li").first()).toHaveText(/^studio-fixture-dev\s*Dev\s*dev stage$/);
  await expect(deployments).not.toContainText("→");
  const field = editor.getByRole("textbox", { name: "Name", exact: true });
  await expect(field).toBeFocused();
  await expect(editor.getByRole("button", { name: "Review", exact: true })).toBeDisabled();
  await field.fill("Acme");
  await expect(editor.getByRole("alert")).toHaveText("Use lowercase letters.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await field.fill("acme");
  await expect(deployments).toContainText("studio-fixture-dev → acme-dev");
  await expect(deployments).toContainText("Checked in AWS when you review");
  await assertAccessible(page);
  await editor.getByRole("button", { name: "Review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "studio-fixture → acme" });
  await expect(review).toContainText("prod stage · Deployed as this name · keeps it");
  await expect(review).not.toContainText("studio-fixture-prod →");
  await expect(review).not.toContainText("Pinned");
  // The edit is shown as every source review shows one: removed lines red, added lines green.
  const diff = review.getByRole("region", { name: "Changes to cdk-app/cdk.json", exact: true });
  await expect(diff.locator("tr.bg-removed")).toHaveText([/-\s*"framework:app": "studio-fixture"/]);
  await expect(diff.locator("tr.bg-added")).toHaveText([/\+\s*"framework:app": "acme"/]);
  await diff.click();
  await expect(review.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  expect(reviews.at(-1)).toEqual({ name: "acme", hash: "fixture-hash", profiles: expect.anything() });
  expect(applied).toBe(false);
  await assertAccessible(page);
  await review.getByRole("button", { name: "Back", exact: true }).click();
  await expect(field).toHaveValue("acme");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await field.fill("acme");
  await editor.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("dialog", { name: "studio-fixture → acme" }).getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "studio-fixture → acme" })).toBeHidden();
  expect(applied).toBe(true);
});

test("when AWS can't be checked, production follows the new name and the review says deploying checks again", async ({ page, studio }) => {
  studio.reply("GET", "/api/app-name", (route) => route.fulfill({ json: view }));
  studio.reply("POST", "/api/app-name/review", (route) => route.fulfill({ json: uncheckedReview }));
  await studio.goto("/graphql");
  await page.getByRole("button", { name: "App name: studio-fixture. Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("acme");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "studio-fixture → acme" });
  await expect(review).toContainText("studio-fixture-prod → acme-prod");
  await expect(review).toContainText("prod stage · Couldn't check AWS · follows the new name");
  await expect(review).toContainText("No Production AWS profile is selected.");
  await expect(review).toContainText("If production is already deployed, deploying acme-prod stops and offers to keep its name.");
  await expect(review.getByRole("button", { name: /isn't deployed/ })).toHaveCount(0);
});

test("an app with no permanent id says it can't be deployed, and an unchanged name can be reviewed to add one", async ({ page, studio }) => {
  const problem = 'cdk-app/cdk.json has no "framework:appId".';
  Object.assign(studio.response, { snapshot: { ...studio.response.snapshot, application: { name: "studio-fixture", problem, needsId: true } } });
  studio.reply("GET", "/api/app-name", (route) => route.fulfill({ json: { ...view, appId: undefined, needsId: true, problem } }));
  let reviewed: unknown;
  studio.reply("POST", "/api/app-name/review", (route) => {
    reviewed = route.request().postDataJSON();
    return route.fulfill({ json: { ...deployedReview, name: "studio-fixture", rows: [], warnings: ["Adds framework:appId, a permanent id every stack is tagged with, so this app's deployments are recognized whatever it is called."] } });
  });
  await studio.goto("/graphql");
  const trigger = page.getByRole("button", { name: "App name: studio-fixture. Needs attention", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const editor = page.getByRole("dialog", { name: "studio-fixture" });
  await expect(editor).toContainText("This app has no permanent id yet, so it can't be deployed. Review adds one.");
  await editor.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "studio-fixture", exact: true })).toContainText("Adds framework:appId");
  expect(reviewed).toMatchObject({ name: "studio-fixture" });
});

for (const width of [1100, 1201, 760])
  test(`the app name stays reachable from the navbar at ${width}px without changing its height`, async ({ page, studio }) => {
    await page.setViewportSize({ width, height: 800 });
    await studio.goto("/graphql");
    const trigger = page.getByRole("button", { name: "App name: studio-fixture. Rename", exact: true });
    await expect(trigger).toBeVisible();
    // Between 761 and 1200px the navigation strip needs the room: the pencil stays, the name hides.
    const label = trigger.getByText("studio-fixture", { exact: true });
    if (width > 760 && width <= 1200) await expect(label).toBeHidden();
    else await expect(label).toBeVisible();
  });
