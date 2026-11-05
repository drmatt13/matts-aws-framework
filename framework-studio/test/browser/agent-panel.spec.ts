import type { Page } from "@playwright/test";
import { test, expect, assertAccessible, type Handler } from "./support/test";

type Replies = { reply(method: string, pathname: string, handler: Handler): void };
const availability = (available = true) => ({
  providers: ["codex", "claude"].map(id => ({
    id, label: id === "codex" ? "Codex" : "Claude", available,
    detail: available ? "Installed · signed in" : "Fixture CLI needs a terminal login.",
  })),
  busy: false,
});
const modelCatalog = (provider: string) => ({
  provider, source: "cli",
  models: provider === "claude"
    ? [{ id: "claude-balanced", label: "Claude Balanced", isDefault: true }, { id: "claude-deep", label: "Claude Deep" }]
    : [{ id: "codex-fast", label: "Codex Fast", isDefault: true }, { id: "codex-reasoning", label: "Codex Reasoning" }],
});
test.beforeEach(async ({ studio }) => {
  studio.reply("GET", "/api/agent-lab/models", (route, url) => route.fulfill({ json: modelCatalog(url.searchParams.get("provider") ?? "codex") }));
});
const installAgents = (studio: Replies) => studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: availability() }));
const tray = (page: Page) => page.getByRole("region", { name: "Activity", exact: true });
const agentTab = (page: Page) => tray(page).getByRole("tab", { name: /^Agent/ });
const activityTab = (page: Page) => tray(page).getByRole("tab", { name: /^Activity/ });
const agentPanel = (page: Page) => tray(page).getByRole("tabpanel", { name: /^Agent/ });
const question = (page: Page) => agentPanel(page).getByRole("textbox", { name: "Ask the agent", exact: true });
const toggle = (page: Page) => tray(page).getByRole("button", { name: /^(Activity|Agent): (expand|collapse) panel$/ });
async function openAgent(page: Page) {
  await agentTab(page).click();
  if (await toggle(page).getAttribute("aria-expanded") === "false") await toggle(page).click();
  await expect(agentPanel(page)).toBeVisible();
}

for (const width of [1440, 390]) test(`Choosing a panel mode preserves the drawer state at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 844 });
  installAgents(studio);
  await studio.goto("/graphql");
  const closed = (await tray(page).boundingBox())!;
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await agentTab(page).click();
  await expect(agentTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(agentPanel(page)).toBeHidden();
  expect((await tray(page).boundingBox())!.height).toBe(closed.height);
  await activityTab(page).click();
  await expect(activityTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await agentTab(page).click();
  await toggle(page).click();
  await expect(agentPanel(page)).toBeVisible();
  const expanded = (await tray(page).boundingBox())!;
  expect(expanded.height).toBeGreaterThan(closed.height + 100);
  await question(page).fill("Keep my draft when I switch modes.");
  await activityTab(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(tray(page).getByRole("tabpanel", { name: "Activity", exact: true })).toBeVisible();
  expect((await tray(page).boundingBox())!.height).toBe(expanded.height);
  await agentTab(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(question(page)).toHaveValue("Keep my draft when I switch modes.");
  expect((await tray(page).boundingBox())!.height).toBe(expanded.height);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await activityTab(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  expect((await tray(page).boundingBox())!.height).toBe(closed.height);
});

test("The panel animates through intermediate heights and can reverse while opening", async ({ page, studio }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  installAgents(studio);
  await studio.goto("/graphql");
  const samples = await tray(page).evaluate(async region => {
    const button = region.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    const height = () => region.getBoundingClientRect().height;
    const sample = () => new Promise<number[]>(resolve => {
      const values = [height()], started = performance.now();
      const frame = () => {
        values.push(height());
        if (performance.now() - started >= 450) resolve(values);
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const closed = height();
    button.click();
    const opening = await sample();
    const open = height();
    button.click();
    const closing = await sample();
    button.click();
    let reversedAt: number | undefined;
    const reversing = await new Promise<number[]>(resolve => {
      const values = [height()], started = performance.now();
      const frame = () => {
        const current = height();
        values.push(current);
        if (reversedAt === undefined && current > closed + 8) { reversedAt = current; button.click(); }
        if (performance.now() - started >= 550) resolve(values);
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    return { closed, open, opening, closing, reversing, reversedAt, finalExpanded: button.getAttribute("aria-expanded") };
  });
  expect(samples.open).toBeGreaterThan(samples.closed + 100);
  expect(samples.opening.some(height => height > samples.closed + 2 && height < samples.open - 2)).toBe(true);
  expect(samples.closing.some(height => height > samples.closed + 2 && height < samples.open - 2)).toBe(true);
  expect(samples.closing.at(-1)).toBeCloseTo(samples.closed, 1);
  expect(samples.reversedAt).toBeDefined();
  expect(samples.reversedAt!).toBeLessThan(samples.open - 2);
  expect(samples.reversing.at(-1)).toBeCloseTo(samples.closed, 1);
  expect(samples.finalExpanded).toBe("false");
  await expect(page.locator('[data-ui="activity-drawer"]')).toHaveCount(0);
});

test("Reduced motion opens and closes the panel without intermediate animation", async ({ page, studio }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  installAgents(studio);
  await studio.goto("/graphql");
  const sizes = await tray(page).evaluate(async region => {
    const button = region.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    const height = () => region.getBoundingClientRect().height;
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const closed = height();
    button.click(); await frame(); await frame();
    const firstOpen = height();
    await frame(); await frame();
    const settledOpen = height();
    button.click(); await frame(); await frame();
    const firstClosed = height();
    await frame(); await frame();
    return { closed, firstOpen, settledOpen, firstClosed, settledClosed: height() };
  });
  expect(sizes.firstOpen).toBeGreaterThan(sizes.closed + 100);
  expect(sizes.firstOpen).toBe(sizes.settledOpen);
  expect(sizes.firstClosed).toBe(sizes.closed);
  expect(sizes.settledClosed).toBe(sizes.closed);
});

test("Model choices belong to each provider and the selected model accompanies the question", async ({ page, studio }) => {
  installAgents(studio);
  studio.reply("POST", "/api/agent-lab/chat", route => route.fulfill({ json: { answer: "A reply from the selected model." } }));
  await studio.goto("/graphql");
  await openAgent(page);
  const panel = agentPanel(page);
  const provider = panel.getByRole("combobox", { name: "Agent provider", exact: true });
  const model = panel.getByRole("combobox", { name: "Agent model", exact: true });
  await expect(model).toHaveValue("");
  await model.selectOption("codex-reasoning");
  await provider.selectOption("claude");
  await expect(model).toHaveValue("");
  await model.selectOption("claude-deep");
  await provider.selectOption("codex");
  await expect(model).toHaveValue("codex-reasoning");
  await question(page).fill("Use my chosen Codex model.");
  await question(page).press("Enter");
  await expect(panel.getByRole("article", { name: "Codex answer", exact: true })).toContainText("A reply from the selected model.");
  let posts = studio.requests.filter(request => request.path === "/api/agent-lab/chat");
  expect(posts[0].body).toEqual({ provider: "codex", model: "codex-reasoning", messages: [{ role: "user", content: "Use my chosen Codex model." }] });
  await activityTab(page).click();
  await toggle(page).click();
  await agentTab(page).click();
  await toggle(page).click();
  await expect(model).toHaveValue("codex-reasoning");
  await provider.selectOption("claude");
  await expect(model).toHaveValue("claude-deep");
  await question(page).fill("Now use my chosen Claude model.");
  await question(page).press("Enter");
  await expect(panel.getByRole("article", { name: "Claude answer", exact: true })).toContainText("A reply from the selected model.");
  posts = studio.requests.filter(request => request.path === "/api/agent-lab/chat");
  expect(posts[1].body).toMatchObject({ provider: "claude", model: "claude-deep" });
  await model.selectOption("");
  await question(page).fill("Let the CLI choose this time.");
  await question(page).press("Enter");
  await expect(panel.getByRole("article", { name: "Claude answer", exact: true })).toHaveCount(2);
  posts = studio.requests.filter(request => request.path === "/api/agent-lab/chat");
  expect(posts[2].body).toMatchObject({ provider: "claude" });
  expect(posts[2].body).not.toHaveProperty("model");
  expect(studio.requests.some(request => request.path === "/api/agent-lab/models?provider=codex")).toBe(true);
  expect(studio.requests.some(request => request.path === "/api/agent-lab/models?provider=claude")).toBe(true);
});

test("CLI default remains usable while model discovery loads or fails and catalogs can be refreshed", async ({ page, studio }) => {
  installAgents(studio);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let recovered = false;
  studio.reply("GET", "/api/agent-lab/models", async (route, url) => {
    await held;
    const provider = url.searchParams.get("provider") ?? "codex";
    await route.fulfill({ json: recovered ? modelCatalog(provider) : { provider, models: [], source: "cli", problem: "Fixture model discovery unavailable." } });
  });
  studio.reply("POST", "/api/agent-lab/chat", route => route.fulfill({ json: { answer: "The CLI default answered." } }));
  await studio.goto("/graphql");
  await openAgent(page);
  const panel = agentPanel(page);
  const model = panel.getByRole("combobox", { name: "Agent model", exact: true });
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue("");
  await question(page).fill("A question while the catalog is loading.");
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  release();
  await expect(panel).toContainText("Fixture model discovery unavailable. You can still use CLI default.");
  await expect(model).toBeEnabled();
  await question(page).press("Enter");
  await expect(panel.getByRole("article", { name: "Codex answer", exact: true })).toContainText("The CLI default answered.");
  const post = studio.requests.find(request => request.path === "/api/agent-lab/chat")!;
  expect(post.body).not.toHaveProperty("model");
  recovered = true;
  await panel.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(panel.getByText("Fixture model discovery unavailable. You can still use CLI default.", { exact: true })).toHaveCount(0);
  await model.selectOption("codex-fast");
  await expect(model).toHaveValue("codex-fast");
});

for (const width of [1440, 390]) test(`Agent composer, keyboard sending and answers remain usable at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 844 });
  installAgents(studio);
  studio.reply("POST", "/api/agent-lab/chat", route => route.fulfill({ json: {
    answer: "Start with **framework.config.ts**.\n\n- Declare the route.\n- Add its handler.\n\n```ts\nconst message = 'A deliberately long example keeps code scrollable without pushing the surrounding composer outside the viewport.';\n```",
  } }));
  await studio.goto("/graphql");
  await openAgent(page);
  await expect(agentTab(page)).toHaveAttribute("aria-selected", "true");
  const panel = agentPanel(page);
  const input = question(page);
  const send = panel.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await panel.getByRole("button", { name: "Understand this project", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).not.toHaveValue("");
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
  await panel.getByRole("combobox", { name: "Agent provider", exact: true }).selectOption("claude");
  await input.fill("Explain a route.");
  await input.press("End");
  await input.press("Shift+Enter");
  await input.pressSequentially("Keep it brief.");
  await expect(input).toHaveValue("Explain a route.\nKeep it brief.");
  await expect(send).toBeEnabled();
  expect(studio.requests.filter(request => request.path === "/api/agent-lab/chat")).toHaveLength(0);
  await input.press("Enter");
  const reply = panel.getByRole("article", { name: "Claude answer", exact: true });
  await expect(reply).toContainText("Start with framework.config.ts.");
  await expect(reply.getByRole("listitem")).toHaveCount(2);
  await expect(reply.getByLabel("Code example", { exact: true })).toContainText("const message");
  await expect(input).toHaveValue("");
  await expect(send).toBeDisabled();
  const posted = studio.requests.filter(request => request.path === "/api/agent-lab/chat");
  expect(posted).toHaveLength(1);
  expect(posted[0].body).toEqual({ provider: "claude", messages: [{ role: "user", content: "Explain a route.\nKeep it brief." }] });
  const geometry = await page.evaluate(() => {
    const input = document.querySelector("#studio-agent-question")!.getBoundingClientRect();
    const send = document.querySelector('[data-ui="agent-panel"] button[type="submit"]')!.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      input: { left: input.left, right: input.right, top: input.top, bottom: input.bottom },
      send: { left: send.left, right: send.right, top: send.top, bottom: send.bottom } };
  });
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width);
  for (const control of [geometry.input, geometry.send]) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(geometry.width);
    expect(control.top).toBeGreaterThanOrEqual(0);
    expect(control.bottom).toBeLessThanOrEqual(geometry.height);
  }
  await assertAccessible(page);
});

test("Agent replies finish in the background and conversation plus draft survive navigation and collapse", async ({ page, studio }) => {
  installAgents(studio);
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  studio.reply("POST", "/api/agent-lab/chat", async route => {
    await held;
    await route.fulfill({ json: { answer: "A background answer to the first question." } });
  });
  await studio.goto("/graphql");
  await openAgent(page);
  await question(page).fill("How should I start?");
  await agentPanel(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(agentPanel(page).getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await question(page).fill("An unfinished follow-up");
  await activityTab(page).click();
  await expect(activityTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(agentPanel(page)).toBeHidden();
  finish();
  await expect(agentTab(page).locator('[aria-label="New reply"]')).toBeVisible();
  await expect(activityTab(page)).toHaveAttribute("aria-selected", "true");
  await agentTab(page).click();
  await expect(agentPanel(page).getByRole("article", { name: "Codex answer", exact: true })).toContainText("A background answer");
  await expect(question(page)).toHaveValue("An unfinished follow-up");
  await expect(agentTab(page).locator('[aria-label="New reply"]')).toHaveCount(0);
  await tray(page).getByRole("button", { name: "Agent: collapse panel", exact: true }).click();
  await expect(question(page)).toBeHidden();
  await expect(page.locator('[data-ui="activity-drawer"]')).toHaveCount(0);
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "WebSockets", exact: true }).click();
  await tray(page).getByRole("button", { name: "Agent: expand panel", exact: true }).click();
  await expect(question(page)).toHaveValue("An unfinished follow-up");
  await expect(agentPanel(page).getByRole("article", { name: "Codex answer", exact: true })).toContainText("A background answer");
  expect(studio.requests.filter(request => request.path === "/api/agent-lab/chat")).toHaveLength(1);
});

test("Agent mode tabs support arrow, Home and End keyboard navigation", async ({ page, studio }) => {
  installAgents(studio);
  await studio.goto("/graphql");
  await activityTab(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(agentTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(agentTab(page)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(activityTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(activityTab(page)).toBeFocused();
  await page.keyboard.press("End");
  await expect(agentTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(agentTab(page)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(activityTab(page)).toBeFocused();
  await expect(activityTab(page)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await toggle(page).click();
  await question(page).fill("A draft kept when Escape closes the panel.");
  await question(page).press("Escape");
  await expect(agentPanel(page)).toBeHidden();
  await expect(page.locator('[data-ui="activity-drawer"]')).toHaveCount(0);
  await expect(agentTab(page)).toBeFocused();
  await expect(tray(page).getByRole("button", { name: "Agent: expand panel", exact: true })).toHaveAttribute("aria-expanded", "false");
});

test("A failed answer can be retried without duplicating the question, and clearing a chat is explicit", async ({ page, studio }) => {
  installAgents(studio);
  let fail = true;
  studio.reply("POST", "/api/agent-lab/chat", route => route.fulfill(fail
    ? { status: 502, json: { error: "Fixture provider temporarily unavailable." } }
    : { json: { answer: "The retry succeeded." } }));
  await studio.goto("/graphql");
  await openAgent(page);
  await question(page).fill("Explain the workflow.");
  await agentPanel(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(agentPanel(page).getByRole("alert")).toContainText("Fixture provider temporarily unavailable");
  await expect(agentPanel(page).getByRole("article", { name: "Your question", exact: true })).toHaveCount(1);
  fail = false;
  await agentPanel(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(agentPanel(page).getByRole("article", { name: "Codex answer", exact: true })).toContainText("The retry succeeded.");
  await expect(agentPanel(page).getByRole("alert")).toHaveCount(0);
  await expect(agentPanel(page).getByRole("article", { name: "Your question", exact: true })).toHaveCount(1);
  const attempts = studio.requests.filter(request => request.path === "/api/agent-lab/chat");
  expect(attempts).toHaveLength(2);
  expect(attempts[1].body).toEqual(attempts[0].body);
  await agentPanel(page).getByRole("button", { name: "New chat", exact: true }).click();
  await agentPanel(page).getByRole("button", { name: "Keep", exact: true }).click();
  await expect(agentPanel(page).getByRole("article")).toHaveCount(2);
  await agentPanel(page).getByRole("button", { name: "New chat", exact: true }).click();
  await agentPanel(page).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(agentPanel(page).getByRole("article")).toHaveCount(0);
  await expect(question(page)).toBeFocused();
});

test("Stopping an answer preserves the question and ignores the late response", async ({ page, studio }) => {
  installAgents(studio);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let completed!: () => void;
  const settled = new Promise<void>(resolve => { completed = resolve; });
  studio.reply("POST", "/api/agent-lab/chat", async route => {
    await held;
    try { await route.fulfill({ json: { answer: "This canceled reply must never appear." } }); }
    catch { /* The browser may already have closed the aborted fetch. */ }
    finally { completed(); }
  });
  await studio.goto("/graphql");
  await openAgent(page);
  await question(page).fill("A question I will stop.");
  await agentPanel(page).getByRole("button", { name: "Send", exact: true }).click();
  await agentPanel(page).getByRole("button", { name: "Stop", exact: true }).click();
  await expect(agentPanel(page).getByRole("status").filter({ hasText: "Response stopped." })).toBeVisible();
  await expect(agentPanel(page).getByRole("article", { name: "Your question", exact: true })).toContainText("A question I will stop.");
  release();
  await settled;
  await expect(agentPanel(page).getByRole("article", { name: "Codex answer", exact: true })).toHaveCount(0);
  studio.reply("POST", "/api/agent-lab/chat", route => route.fulfill({ json: { answer: "A fresh response after stopping." } }));
  await agentPanel(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(agentPanel(page).getByRole("article", { name: "Codex answer", exact: true })).toContainText("A fresh response after stopping.");
  await expect(agentPanel(page).getByText("This canceled reply must never appear.", { exact: true })).toHaveCount(0);
});

test("Agent automatically recovers after stopping and excludes unanswered questions from the next request", async ({ page, studio }) => {
  let stopping = false, statusAfterStop = 0;
  let allowIdle!: () => void;
  const idle = new Promise<void>(resolve => { allowIdle = resolve; });
  studio.reply("GET", "/api/agent-lab/status", async route => {
    if (!stopping) { await route.fulfill({ json: availability() }); return; }
    statusAfterStop++;
    if (statusAfterStop === 1) { await route.fulfill({ json: { ...availability(), busy: true } }); return; }
    await idle;
    await route.fulfill({ json: availability() });
  });
  let releaseFirst!: () => void;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  let first = true;
  studio.reply("POST", "/api/agent-lab/chat", async route => {
    if (!first) { await route.fulfill({ json: { answer: "The new question has its own answer." } }); return; }
    first = false;
    await held;
    try { await route.fulfill({ json: { answer: "The stopped response must stay discarded." } }); }
    catch { /* The browser canceled the first fetch. */ }
  });
  await studio.goto("/graphql");
  await openAgent(page);
  await question(page).fill("The first, unanswered question.");
  await agentPanel(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(agentPanel(page).getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  stopping = true;
  await agentPanel(page).getByRole("button", { name: "Stop", exact: true }).click();
  releaseFirst();
  await question(page).fill("A new question after stopping.");
  await expect(agentPanel(page)).toContainText("Another agent request is running.");
  await expect(agentPanel(page).getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  // The second read must come from polling; no manual Check again is clicked.
  await expect.poll(() => statusAfterStop).toBeGreaterThanOrEqual(2);
  allowIdle();
  await expect(agentPanel(page).getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await agentPanel(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(agentPanel(page).getByRole("article", { name: "Codex answer", exact: true })).toContainText("The new question has its own answer.");
  const questions = agentPanel(page).getByRole("article", { name: "Your question", exact: true });
  await expect(questions).toHaveCount(2);
  await expect(questions.first()).toContainText("The first, unanswered question.");
  await expect(questions.first()).toContainText("Reply stopped");
  const posts = studio.requests.filter(request => request.path === "/api/agent-lab/chat");
  expect(posts).toHaveLength(2);
  expect(posts[1].body).toEqual({ provider: "codex", messages: [{ role: "user", content: "A new question after stopping." }] });
  await expect(agentPanel(page).getByText("The stopped response must stay discarded.", { exact: true })).toHaveCount(0);
});

test("Agent availability shows loading and a recoverable login requirement without losing the draft", async ({ page, studio }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let ready = false;
  studio.reply("GET", "/api/agent-lab/status", async route => {
    await held;
    await route.fulfill({ json: availability(ready) });
  });
  await studio.goto("/graphql");
  await openAgent(page);
  await expect(agentPanel(page).getByRole("status").filter({ hasText: "Checking your local agents" })).toBeVisible();
  await question(page).fill("Keep this question while I sign in.");
  release();
  await expect(agentPanel(page)).toContainText("Fixture CLI needs a terminal login.");
  await expect(agentPanel(page).getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  ready = true;
  await agentPanel(page).getByRole("button", { name: "Check again", exact: true }).click();
  await expect(agentPanel(page).getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(question(page)).toHaveValue("Keep this question while I sign in.");
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});
