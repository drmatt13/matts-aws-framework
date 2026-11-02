import { test, expect, assertAccessible } from "./support/test";
import { connectionCatalogFixture, connectionObservationFixture } from "./support/aws-connections";

const catalog = connectionCatalogFixture();
const profileChecks = (requests: readonly { path: string }[]) =>
  requests.filter((request) => request.path === "/api/aws-connections/check");

async function openConfiguration(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await page.getByRole("button", { name: "Configure AWS profiles" }).click();
  return page.getByRole("dialog", { name: "AWS profile configuration", exact: true });
}

test.beforeEach(async ({ studio, context }) => {
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem("aws-connections-onboarding-fixture")) {
        localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", "{}");
        localStorage.setItem("aws-connections-onboarding-fixture", "1");
      }
    } catch {
      /* Storage-failure tests retain session choices. */
    }
  });
  studio.reply("GET", "/api/aws-connections", (route) => route.fulfill({ json: catalog }));
  studio.reply("POST", "/api/aws-connections/check", (route) =>
    route.fulfill({ json: connectionObservationFixture(route.request().postDataJSON().profile) }),
  );
});

for (const width of [1440, 320])
  test(`mode buttons preserve the open profile panel at ${width}px`, async ({ page, studio }) => {
    await page.setViewportSize({ width, height: 800 });
    await studio.goto("/graphql");
    const trigger = page.getByRole("button", { name: /AWS profile:/ });
    await trigger.click();
    const panel = page.getByRole("dialog");
    const select = page.getByRole("combobox", { name: "AWS profile", exact: true });
    await select.selectOption("dev");
    await expect(panel).toContainText("Developer / tester");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(select).toHaveValue("");
    await select.selectOption("production");
    await expect(panel).toContainText("eu-west-1");
    await page.getByRole("button", { name: "Development", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(select).toHaveValue("dev");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Development", exact: true })).toBeFocused();
    expect(
      studio.requests.filter(
        (request) => request.method !== "GET" && request.path !== "/api/aws-connections/check",
      ),
    ).toEqual([]);
    expect(
      studio.requests.some((request) => /deploy\/(discover|status|overview)/.test(request.path)),
    ).toBe(false);
  });

test("associations persist, allow reuse and clear independently without repeated identity requests", async ({
  page,
  studio,
}) => {
  await studio.goto("/graphql");
  const trigger = () => page.getByRole("button", { name: /AWS profile:/ });
  await trigger().click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("dev");
  await expect(page.getByRole("dialog")).toContainText("123456789012");
  await page.keyboard.press("Escape");
  await trigger().click();
  await expect(page.getByRole("dialog")).toContainText("123456789012");
  expect(profileChecks(studio.requests)).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await trigger().click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("dev");
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(trigger()).toHaveAccessibleName("Development AWS profile: dev");
});

for (const width of [1440, 320])
  test(`configuration dialog fits ${width}px, keeps focus and performs discovery only`, async ({
    page,
    studio,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await studio.goto("/graphql");
    const modal = await openConfiguration(page);
    await expect(modal).toBeVisible();
    await expect(modal).not.toContainText("Placeholder");
    expect(await modal.evaluate((element) => element.matches(":modal"))).toBe(true);
    const close = modal.getByRole("button", { name: "Close AWS profile configuration" });
    await expect(close).toBeFocused();
    const bounds = await modal.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("aws-configuration.png") });
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Development AWS profile:/ })).toBeFocused();
    expect(profileChecks(studio.requests)).toHaveLength(0);
  });

test("profile details test explicitly and show cached identity plus safe editable configuration", async ({
  page,
  studio,
}) => {
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await modal.getByRole("button", { name: /dev IAM Identity Center/ }).click();
  await expect(modal).toContainText("Not checked");
  expect(profileChecks(studio.requests)).toHaveLength(0);
  await modal.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(modal).toContainText("Developer / tester");
  await expect(modal).toContainText("arn:aws:sts::123456789012:assumed-role/Developer/tester");
  await modal.getByRole("button", { name: "Use for Production", exact: true }).click();
  await expect(modal).toContainText("dev is selected for Production");
  await modal.getByRole("button", { name: "Close AWS profile configuration" }).click();
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await expect(page.getByRole("button", { name: /Production AWS profile:/ })).toHaveAccessibleName(
    "Production AWS profile: dev",
  );
});

test("empty, loading and failed discovery have a repair path", async ({ page, studio }) => {
  let resolve!: () => void;
  const wait = new Promise<void>((done) => {
    resolve = done;
  });
  studio.reply("GET", "/api/aws-connections", async (route) => {
    await wait;
    await route.fulfill({ status: 500, json: { error: "Fixture AWS files unavailable" } });
  });
  await studio.goto("/graphql");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Loading AWS profiles");
  resolve();
  await expect(page.getByRole("alert")).toContainText("Fixture AWS files unavailable");
  studio.reply("GET", "/api/aws-connections", (route) =>
    route.fulfill({ json: connectionCatalogFixture([]) }),
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("No AWS profiles on this machine");
  await page.getByRole("button", { name: "Configure AWS profiles" }).click();
  await page.getByRole("button", { name: "Add AWS profile", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "How do you connect to AWS?" })).toBeVisible();
});

test("expired, unavailable and missing profiles never imply another identity", async ({
  page,
  studio,
}) => {
  studio.reply("POST", "/api/aws-connections/check", (route) =>
    route.fulfill({
      json: connectionObservationFixture(route.request().postDataJSON().profile, {
        state: "needs-auth",
        identity: undefined,
        problem: {
          code: "expired",
          message: "Sign in to your Identity Center session.",
          action: "connect",
          retryable: false,
        },
      }),
    }),
  );
  await studio.goto("/graphql");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("dev");
  await expect(page.getByRole("alert")).toContainText("Sign-in required");
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  studio.reply("GET", "/api/aws-connections", (route) =>
    route.fulfill({ json: connectionCatalogFixture([{ name: "production", kind: "sso" }]) }),
  );
  await page.reload();
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await expect(page.getByRole("alert")).toContainText("saved profile “dev” is unavailable");
  await expect(page.getByRole("combobox", { name: "AWS profile" })).toHaveValue("dev");
});

test("role creation reviews safe fields and never changes associations implicitly", async ({
  page,
  studio,
}) => {
  let saved = false;
  studio.reply("POST", "/api/aws-connections/review", (route) => {
    const input = route.request().postDataJSON();
    return route.fulfill({
      json: {
        id: "role-review",
        name: input.name,
        create: true,
        changes: Object.entries(input.fields).map(([field, after]) => ({ field, after })),
        affectedProfiles: [],
        expiresAt: "2026-12-01T00:00:00Z",
      },
    });
  });
  studio.reply("POST", "/api/aws-connections/apply", (route) => {
    saved = true;
    return route.fulfill({ json: { name: "cross-account", message: "Profile saved." } });
  });
  studio.reply("GET", "/api/aws-connections", (route) =>
    route.fulfill({
      json: saved
        ? connectionCatalogFixture([
            ...catalog.profiles,
            { name: "cross-account", kind: "assume-role", region: "us-west-2" },
          ])
        : catalog,
    }),
  );
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await modal.getByRole("button", { name: "Add profile", exact: true }).click();
  await modal.getByRole("combobox", { name: "How do you connect to AWS?" }).selectOption("role");
  await modal.getByRole("textbox", { name: "Profile name", exact: true }).fill("cross-account");
  await modal.getByRole("textbox", { name: "Default AWS region" }).fill("us-west-2");
  await modal.getByRole("combobox", { name: "Source profile", exact: true }).selectOption("dev");
  await modal
    .getByRole("textbox", { name: "Role ARN", exact: true })
    .fill("arn:aws:iam::999999999999:role/Developer");
  await modal.getByRole("button", { name: "Review new profile", exact: true }).click();
  await expect(modal.getByRole("region", { name: "AWS profile change review" })).toContainText(
    "999999999999",
  );
  expect(
    studio.requests.filter((request) => request.path === "/api/aws-connections/apply"),
  ).toHaveLength(0);
  await modal.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(modal).toContainText("Profile saved.");
  await modal.getByRole("button", { name: "Close AWS profile configuration" }).click();
  await expect(page.getByRole("button", { name: /Development AWS profile:/ })).toHaveAccessibleName(
    "Development AWS profile: choose a profile",
  );
});

test("Console sign-in supports cancellation without a raw terminal stream", async ({
  page,
  studio,
}) => {
  const session = {
    id: "console-signin",
    profile: "console-dev",
    method: "login",
    state: "waiting-browser",
    message: "Complete sign-in in your browser.",
    affectedProfiles: [],
    authorizationUrl: "https://signin.aws.amazon.com/authorize",
  };
  studio.reply("POST", "/api/aws-connections/authentication", (route) =>
    route.fulfill({ json: session }),
  );
  studio.reply("GET", "/api/aws-connections/authentication/console-signin", (route) =>
    route.fulfill({ json: session }),
  );
  studio.reply("POST", "/api/aws-connections/authentication/console-signin/cancel", (route) =>
    route.fulfill({ json: { ...session, state: "canceled", message: "Sign-in canceled." } }),
  );
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await modal.getByRole("button", { name: "Add profile", exact: true }).click();
  await modal.getByRole("textbox", { name: "Profile name", exact: true }).fill("console-dev");
  await modal.getByRole("textbox", { name: "Default AWS region" }).fill("us-east-1");
  await modal.getByRole("button", { name: "Continue to sign in", exact: true }).click();
  await expect(modal.getByRole("link", { name: "Continue sign-in in your browser" })).toBeVisible();
  await modal.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(modal).toContainText("Sign-in canceled");
  expect(studio.requests.filter((request) => request.path.endsWith("/apply"))).toHaveLength(0);
});

test("Identity Center setup picks assigned account and permission set before review", async ({
  page,
  studio,
}) => {
  const session = {
    id: "sso-signin",
    profile: "team-new",
    method: "sso",
    state: "complete",
    message: "Identity Center authentication completed.",
    affectedProfiles: [],
    reviewRequired: true,
  };
  studio.reply("POST", "/api/aws-connections/authentication", (route) =>
    route.fulfill({ json: session }),
  );
  studio.reply("GET", "/api/aws-connections/authentication/sso-signin/accounts", (route) =>
    route.fulfill({ json: { accounts: [{ accountId: "444455556666", accountName: "Sandbox" }] } }),
  );
  studio.reply("POST", "/api/aws-connections/authentication/sso-signin/roles", (route) =>
    route.fulfill({ json: { roles: [{ roleName: "DeveloperAccess" }] } }),
  );
  studio.reply("POST", "/api/aws-connections/review", (route) =>
    route.fulfill({
      json: {
        id: "sso-review",
        name: "team-new",
        create: true,
        changes: [
          { field: "sso_account_id", after: "444455556666" },
          { field: "sso_role_name", after: "DeveloperAccess" },
        ],
        affectedProfiles: [],
        expiresAt: "2026-12-01T00:00:00Z",
      },
    }),
  );
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await modal.getByRole("button", { name: "Add profile", exact: true }).click();
  await modal.getByRole("combobox", { name: "How do you connect to AWS?" }).selectOption("sso");
  await modal.getByRole("textbox", { name: "Profile name", exact: true }).fill("team-new");
  await modal
    .getByRole("combobox", { name: "Identity Center session", exact: true })
    .selectOption("team-session");
  await modal.getByRole("button", { name: "Continue to sign in", exact: true }).click();
  await modal
    .getByRole("combobox", { name: "AWS account", exact: true })
    .selectOption("444455556666");
  await modal
    .getByRole("combobox", { name: "Permission set", exact: true })
    .selectOption("DeveloperAccess");
  await modal.getByRole("button", { name: "Review new profile", exact: true }).click();
  await expect(modal.getByRole("region", { name: "AWS profile change review" })).toContainText(
    "DeveloperAccess",
  );
  expect(studio.requests.filter((request) => request.path.endsWith("/apply"))).toHaveLength(0);
});

test("access-key setup stays in the terminal and never renders secret inputs", async ({
  page,
  studio,
}) => {
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await modal.getByRole("button", { name: "Add profile", exact: true }).click();
  await modal.getByRole("combobox", { name: "How do you connect to AWS?" }).selectOption("static");
  await expect(modal).toContainText("aws configure --profile your-profile-name");
  await expect(modal.getByRole("textbox")).toHaveCount(0);
  expect(studio.requests.filter((request) => request.method !== "GET")).toEqual([]);
});

test("another tab updates the mode association without losing the current choice", async ({
  context,
  page,
  studio,
}) => {
  await studio.goto("/graphql");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("dev");
  await page.keyboard.press("Escape");
  const other = await context.newPage();
  await other.goto("/graphql");
  await other.getByRole("button", { name: "Production", exact: true }).click();
  await other.getByRole("button", { name: /Production AWS profile:/ }).click();
  await other.getByRole("combobox", { name: "AWS profile" }).selectOption("production");
  await expect(page.getByRole("button", { name: /Development AWS profile:/ })).toHaveAccessibleName(
    "Development AWS profile: dev",
  );
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await expect(page.getByRole("button", { name: /Production AWS profile:/ })).toHaveAccessibleName(
    "Production AWS profile: production",
  );
  await other.close();
});

test("reviewed edits retain entered settings after a stale-file rejection", async ({
  page,
  studio,
}) => {
  studio.reply("POST", "/api/aws-connections/review", (route) =>
    route.fulfill({
      json: {
        id: "edit-review",
        name: "dev",
        create: false,
        changes: [{ field: "region", before: "us-east-1", after: "ap-southeast-2" }],
        affectedProfiles: ["dev"],
        expiresAt: "2026-12-01T00:00:00Z",
      },
    }),
  );
  studio.reply("POST", "/api/aws-connections/apply", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "AWS configuration changed after review. Nothing was written." },
    }),
  );
  studio.reply("POST", "/api/aws-connections/discard", (route) =>
    route.fulfill({ json: { discarded: true } }),
  );
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await modal.getByRole("button", { name: /dev IAM Identity Center/ }).click();
  await modal
    .getByRole("textbox", { name: "Default AWS region", exact: true })
    .fill("ap-southeast-2");
  await modal.getByRole("button", { name: "Review configuration changes", exact: true }).click();
  await expect(modal.getByRole("region", { name: "AWS profile change review" })).toContainText(
    "us-east-1 → ap-southeast-2",
  );
  await modal.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("Nothing was written");
  await modal.getByRole("button", { name: "Back", exact: true }).click();
  await expect(modal.getByRole("textbox", { name: "Default AWS region", exact: true })).toHaveValue(
    "ap-southeast-2",
  );
});

test("Identity Center sign-out discloses shared impact and cancellation sends no logout", async ({
  page,
  studio,
}) => {
  studio.reply("POST", "/api/aws-connections/logout/review", (route) =>
    route.fulfill({
      json: {
        id: "logout-review",
        profile: "dev",
        method: "sso",
        affectedProfiles: ["dev", "production"],
        message: "AWS CLI signs out all Identity Center sessions on this machine.",
        expiresAt: "2026-12-01T00:00:00Z",
      },
    }),
  );
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await modal.getByRole("button", { name: /dev IAM Identity Center/ }).click();
  await modal.getByRole("button", { name: "Sign out…", exact: true }).click();
  const review = modal.getByRole("region", { name: "AWS sign-out review" });
  await expect(review).toContainText("Sign out of all Identity Center sessions");
  await expect(review).toContainText("dev, production");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    studio.requests.some((request) => request.path === "/api/aws-connections/logout/apply"),
  ).toBe(false);
});

test("credential lifecycle events mark observations stale without another provider execution", async ({
  page,
  studio,
}) => {
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await modal.getByRole("button", { name: /dev IAM Identity Center/ }).click();
  await modal.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(modal.getByRole("status").first()).toContainText("Identity verified");
  await studio.emit("aws-connections", { profiles: ["dev"] });
  await expect(modal.getByRole("status").first()).toContainText("last verified (stale)");
  expect(profileChecks(studio.requests)).toHaveLength(1);
  expect(studio.requests.some((request) => /deploy\/(discover|status)/.test(request.path))).toBe(
    false,
  );
});

test("profile refresh stays icon-only and busy for a full second without checking credentials", async ({
  page,
  studio,
}) => {
  studio.reply("GET", "/api/aws-connections", (route) =>
    route.fulfill({
      json: connectionCatalogFixture(
        Array.from({ length: 5 }, (_, index) => ({ name: `profile-${index}`, kind: "login" })),
      ),
    }),
  );
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await expect(modal.getByRole("searchbox")).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "Check profiles", exact: true })).toHaveCount(0);
  expect(profileChecks(studio.requests)).toHaveLength(0);
  const refresh = modal.getByRole("button", { name: "Refresh AWS profiles", exact: true });
  const before = await refresh.boundingBox();
  await refresh.evaluate((button) => {
    const times = { start: 0, end: 0 };
    (window as unknown as { refreshTimes: typeof times }).refreshTimes = times;
    const observer = new MutationObserver(() => {
      if (button.getAttribute("aria-busy") === "true") times.start ||= performance.now();
      else if (times.start) { times.end = performance.now(); observer.disconnect(); }
    });
    observer.observe(button, { attributes: true, attributeFilter: ["aria-busy"] });
  });
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toHaveAccessibleName("Refresh AWS profiles");
  await expect(refresh).toHaveText("");
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  const duration = await page.evaluate(() => {
    const times = (window as unknown as { refreshTimes: { start: number; end: number } }).refreshTimes;
    return times.end - times.start;
  });
  expect(duration).toBeGreaterThanOrEqual(990);
  expect(await refresh.boundingBox()).toEqual(before);
  expect(profileChecks(studio.requests)).toHaveLength(0);
});

test("blocked browser storage retains both mode choices for the session", async ({
  context,
  page,
  studio,
}) => {
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });
  await studio.goto("/graphql");
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("dev");
  await expect(page.getByRole("alert").filter({ hasText: "kept for this session" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await page.getByRole("button", { name: /Production AWS profile:/ }).click();
  await page.getByRole("combobox", { name: "AWS profile" }).selectOption("production");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(page.getByRole("button", { name: /Development AWS profile:/ })).toHaveAccessibleName(
    "Development AWS profile: dev",
  );
});

test("explicit connection tests show provider expiration without rendering native credential fields", async ({
  page,
  studio,
}) => {
  // Synthetic extra provider fields exercise explicit metadata rendering; real
  // server responses are separately tested to exclude credential material.
  const expiration = {
    at: "2026-10-28T13:00:00.000Z",
    source: "native-export" as const,
    AccessKeyId: "NATIVE_ACCESS_KEY_SENTINEL",
    SecretAccessKey: "NATIVE_SECRET_SENTINEL",
    SessionToken: "NATIVE_SESSION_SENTINEL",
  };
  studio.reply("POST", "/api/aws-connections/check", (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({
      json: connectionObservationFixture(request.profile, {
        ...(request.force ? { credentialExpiration: expiration } : {}),
      }),
    });
  });
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  await modal.getByRole("button", { name: /dev IAM Identity Center/ }).click();
  await expect(modal).not.toContainText("Native provider reports credential expiration");
  await modal.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(modal).toContainText("Native provider reports credential expiration:");
  await expect(modal).toContainText("1:00:00 PM");
  await expect(modal).toContainText("The upstream session may refresh them.");
  await expect(modal).not.toContainText("NATIVE_ACCESS_KEY_SENTINEL");
  await expect(modal).not.toContainText("NATIVE_SECRET_SENTINEL");
  await expect(modal).not.toContainText("NATIVE_SESSION_SENTINEL");
  await expect(modal).not.toContainText("SecretAccessKey");
  await expect(modal).not.toContainText("SessionToken");
  expect(profileChecks(studio.requests)).toHaveLength(1);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 700 }, { width: 320, height: 568 }])
  test(`profile switching and association feedback preserve modal geometry at ${viewport.width}px`, async ({ page, studio }, testInfo) => {
    const profiles = connectionCatalogFixture([
      { name: "dev", kind: "login", region: "us-east-1" },
      { name: "production", kind: "assume-role", region: "eu-west-1" },
    ]);
    const longProfile = profiles.profiles[1]!;
    studio.reply("GET", "/api/aws-connections", route => route.fulfill({ json: {
      ...profiles,
      profiles: [profiles.profiles[0], { ...longProfile, sourceProfile: "dev", roleArn: "arn:aws:iam::123456789012:role/ProductionDeveloper", configuration: { region: "eu-west-1", source_profile: "dev", role_arn: "arn:aws:iam::123456789012:role/ProductionDeveloper" } }],
    } }));
    await page.setViewportSize(viewport);
    await studio.goto("/graphql");
    const modal = await openConfiguration(page);
    const initial = await modal.boundingBox();
    const cards = modal.locator('[data-slot="aws-profile-card"]');
    const cardGeometry = () => cards.evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { y: box.y, height: box.height };
    }));
    const initialCards = await cardGeometry();
    await modal.getByRole("button", { name: /^dev AWS Console/ }).click();
    await expect(modal.getByRole("heading", { name: "dev", exact: true })).toBeVisible();
    if (viewport.width <= 760) await expect(modal.getByRole("heading", { name: "dev", exact: true })).toBeFocused();
    expect(await modal.boundingBox()).toEqual(initial);
    const detail = modal.locator('[data-slot="aws-profile-detail-scroll"]');
    const detailBefore = await detail.boundingBox();
    await modal.getByRole("button", { name: "Use for Production", exact: true }).click();
    await expect(modal.locator('[data-slot="aws-profile-feedback"]')).toContainText("dev is selected for Production");
    expect(await modal.boundingBox()).toEqual(initial);
    expect(await detail.boundingBox()).toEqual(detailBefore);
    if (viewport.width <= 760) {
      await modal.getByRole("button", { name: "All profiles", exact: true }).click();
      await expect(modal.getByRole("button", { name: /^dev AWS Console/ })).toBeFocused();
    }
    expect(await cardGeometry()).toEqual(initialCards);
    await modal.getByRole("button", { name: /^production IAM role/ }).click();
    await modal.getByText("Advanced role settings", { exact: true }).click();
    expect(await modal.boundingBox()).toEqual(initial);
    expect(await detail.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(initial!.height).toBeLessThanOrEqual(viewport.height - 48);
    expect(await modal.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("profile-modal-stable.png") });
  });

test("a failed refresh keeps its spinner for one second and feedback does not move the dialog", async ({ page, studio }) => {
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  const initial = await modal.boundingBox();
  const refresh = modal.getByRole("button", { name: "Refresh AWS profiles", exact: true });
  studio.reply("GET", "/api/aws-connections", route => route.fulfill({ status: 503, json: { error: "Profile discovery is temporarily unavailable." } }));
  const started = Date.now();
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  expect(Date.now() - started).toBeGreaterThanOrEqual(990);
  await expect(modal.getByRole("alert")).toContainText("temporarily unavailable");
  expect(await modal.boundingBox()).toEqual(initial);
  await expect(refresh).toHaveText("");
  await expect(modal.locator('[data-slot="aws-profile-card"]')).toHaveCount(catalog.profiles.length);
});

function deletionReview(name: string, blockers: string[] = [], dependentProfiles: string[] = []) {
  return { id: "delete-review-fixture", name, files: ["config", "credentials"], blockers, dependentProfiles, expiresAt: "2026-12-01T00:00:00Z" };
}

test("short-screen deletion keeps the target visible while its actions receive keyboard focus", async ({ page, studio }) => {
  studio.reply("POST", "/api/aws-connections/delete/review", route => route.fulfill({ json: deletionReview("dev") }));
  studio.reply("POST", "/api/aws-connections/discard", route => route.fulfill({ json: { discarded: true } }));
  await page.setViewportSize({ width: 320, height: 568 });
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  const initial = await modal.boundingBox();
  const trash = modal.getByRole("button", { name: "Delete AWS profile dev", exact: true });
  await trash.click();
  const confirmation = modal.getByRole("region", { name: "Delete AWS profile confirmation" });
  const target = confirmation.getByRole("heading", { name: "Delete profile dev?", exact: true });
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(target).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Tab");
  await expect(confirmation.getByRole("button", { name: "Delete profile", exact: true })).toBeFocused();
  await expect(target).toBeInViewport({ ratio: 1 });
  expect(await modal.boundingBox()).toEqual(initial);
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await expect(trash).toBeFocused();
});

for (const storageBlocked of [false, true])
  test(`confirmed deletion clears both mode associations${storageBlocked ? " with unavailable browser storage" : ""}`, async ({ context, page, studio }) => {
    if (storageBlocked) await context.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("Storage disabled", "SecurityError"); }; });
    let deleted = false;
    studio.reply("GET", "/api/aws-connections", route => route.fulfill({ json: deleted ? { ...catalog, profiles: catalog.profiles.filter(profile => profile.name !== "dev") } : catalog }));
    studio.reply("POST", "/api/aws-connections/delete/review", route => route.fulfill({ json: deletionReview(route.request().postDataJSON().profile) }));
    studio.reply("POST", "/api/aws-connections/delete/apply", route => { deleted = true; return route.fulfill({ json: { name: "dev", changed: true } }); });
    studio.reply("POST", "/api/aws-connections/discard", route => route.fulfill({ json: { discarded: true } }));
    await studio.goto("/graphql");
    const modal = await openConfiguration(page);
    await modal.getByRole("button", { name: /^dev IAM Identity Center/ }).click();
    await modal.getByRole("button", { name: "Use for Development", exact: true }).click();
    await modal.getByRole("button", { name: "Use for Production", exact: true }).click();
    const trash = modal.getByRole("button", { name: "Delete AWS profile dev", exact: true });
    await trash.click();
    const confirmation = modal.getByRole("region", { name: "Delete AWS profile confirmation" });
    await expect(confirmation).toContainText("Development and Production");
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    await expect(confirmation).toHaveCount(0);
    await expect(trash).toBeFocused();
    expect(studio.requests.filter(request => request.path === "/api/aws-connections/delete/apply")).toHaveLength(0);
    await trash.click();
    await confirmation.getByRole("button", { name: "Delete profile", exact: true }).click();
    await expect(modal).toContainText("Deleted profile dev.");
    await expect(modal.getByRole("button", { name: "Delete AWS profile dev", exact: true })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Delete AWS profile production", exact: true })).toBeVisible();
    await assertAccessible(page);
    await modal.getByRole("button", { name: "Close AWS profile configuration" }).click();
    await expect(page.getByRole("button", { name: /Development AWS profile:/ })).toHaveAccessibleName("Development AWS profile: choose a profile");
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await expect(page.getByRole("button", { name: /Production AWS profile:/ })).toHaveAccessibleName("Production AWS profile: choose a profile");
  });

test("dependent profiles block deletion and stale deletion failures preserve the selected connection", async ({ page, studio }) => {
  let blocked = true;
  studio.reply("POST", "/api/aws-connections/delete/review", route => route.fulfill({ json: deletionReview("dev", blocked ? ["Another profile uses this source. Change its source before deleting."] : [], blocked ? ["production"] : []) }));
  studio.reply("POST", "/api/aws-connections/delete/apply", route => route.fulfill({ status: 409, json: { error: "AWS configuration changed after review. Nothing was deleted." } }));
  studio.reply("POST", "/api/aws-connections/discard", route => route.fulfill({ json: { discarded: true } }));
  await studio.goto("/graphql");
  const modal = await openConfiguration(page);
  const initial = await modal.boundingBox();
  await modal.getByRole("button", { name: /^dev IAM Identity Center/ }).click();
  await modal.getByRole("button", { name: "Use for Development", exact: true }).click();
  const trash = modal.getByRole("button", { name: "Delete AWS profile dev", exact: true });
  await trash.click();
  const confirmation = modal.getByRole("region", { name: "Delete AWS profile confirmation" });
  await expect(confirmation).toContainText("production");
  await expect(confirmation.getByRole("button", { name: "Delete profile", exact: true })).toBeDisabled();
  expect(studio.requests.filter(request => request.path === "/api/aws-connections/delete/apply")).toHaveLength(0);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  blocked = false;
  await trash.click();
  await confirmation.getByRole("button", { name: "Delete profile", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("Nothing was deleted");
  expect(await modal.boundingBox()).toEqual(initial);
  await expect(trash).toBeVisible();
  await modal.getByRole("button", { name: "Close AWS profile configuration" }).click();
  await expect(page.getByRole("button", { name: /Development AWS profile:/ })).toHaveAccessibleName("Development AWS profile: dev");
});
