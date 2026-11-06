import type { Page } from "@playwright/test";
import type { AgentRuntimeUpgradeIntentView, CodingEvent, CodingProposal, CodingTask } from "../../shared/agent-runtime";
import { test, expect, assertAccessible } from "./support/test";

const taskId = "fixture-coding-task";
const now = "2026-11-05T12:00:00Z";
const task = (status: CodingTask["status"] = "awaiting_review"): CodingTask => ({ id: taskId, provider: "codex", prompt: "Update the example handler and validate it.", status, createdAt: now, updatedAt: now, lastSeq: 4, proposalDigest: "approved-digest", cancelRequested: false, activation: "none", sourceOutcome: status === "completed" ? "applied" : "unchanged" });
const proposal: CodingProposal = { id: "proposal", taskId, digest: "approved-digest", baselineDigest: "baseline", candidateDigest: "candidate", createdAt: now, activation: "none", limitations: ["Source approval does not deploy infrastructure."], validation: [{ command: "npm run verify", status: "passed", exitCode: 0, candidateDigest: "candidate" }], changes: [{ path: "cdk-app/lambda_functions/http_functions/example/index.ts", kind: "modify", beforeHash: "before", afterHash: "after", beforeMode: 0o644, afterMode: 0o644, binary: false, diff: "--- a/index.ts\n+++ b/index.ts\n@@ -1,1 +1,1 @@\n-return 'before';\n+return 'after';\n" }] };
const progress: CodingEvent[] = [
  { seq: 1, taskId, at: now, type: "state", data: { status: "running" } },
  { seq: 2, taskId, at: now, type: "command", data: { command: "npm run verify", exitCode: 0 } },
  { seq: 3, taskId, at: now, type: "message", data: { text: "The handler is updated and validation passed." } },
  { seq: 4, taskId, at: now, type: "proposal", data: { digest: "approved-digest" } },
];
const panel = (page: Page) => page.getByRole("region", { name: "Coding tasks", exact: true });
async function openCoding(page: Page) {
  const tray = page.getByRole("region", { name: "Activity", exact: true });
  await tray.getByRole("tab", { name: /^Agent/ }).click();
  const toggle = tray.getByRole("button", { name: /^Agent: (expand|collapse) panel$/ });
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await tray.getByRole("tab", { name: "Coding", exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
test.beforeEach(async ({ studio }) => {
  studio.reply("GET", "/api/agent-tasks/recovery", route => route.fulfill({ json: { coordination: { status: "ready", epoch: "fixture" }, recoveries: [] } }));
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: { providers: ["codex", "claude"].map(id => ({ id, label: id, available: true, detail: "Installed" })), busy: false } }));
  studio.reply("GET", "/api/agent-lab/models", (route, url) => route.fulfill({ json: { provider: url.searchParams.get("provider"), source: "cli", models: [{ id: "fixture-model", label: "Fixture coding model" }] } }));
});

test("Agent host restart is explicit, waits for active tasks, and preserves its retry identity across reload", async ({ page, studio }) => {
  let current: CodingTask | undefined = { ...task("running"), proposalDigest: undefined };
  let intent: { requestId: string; targetDigest: string; phase: "ready" } | undefined, attempts = 0;
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: current ? [current] : [] } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, route => route.fulfill({ json: { task: current ?? { ...task("completed"), proposalDigest: undefined, sourceOutcome: "unchanged" }, events: progress } }));
  studio.reply("GET", "/api/agent-tasks/runtime-upgrade", route => route.fulfill({ json: { intent } }));
  studio.reply("POST", "/api/agent-tasks/runtime-upgrade", route => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: "Host restart response disconnected" } });
    intent = { requestId: (route.request().postDataJSON() as { requestId: string }).requestId, targetDigest: "verified-host-release", phase: "ready" };
    return route.fulfill({ json: intent });
  });
  await studio.goto("/graphql"); await openCoding(page);
  expect(studio.requests.filter(request => request.path === "/api/agent-tasks/runtime-upgrade")).toHaveLength(0);
  await panel(page).getByText("Agent host", { exact: true }).click();
  const controls = panel(page).getByRole("region", { name: "Agent host controls", exact: true });
  await expect(controls.getByRole("button", { name: "Restart agent host", exact: true })).toBeDisabled();
  current = undefined; await panel(page).getByRole("button", { name: "Refresh tasks", exact: true }).click();
  await controls.getByRole("button", { name: "Restart agent host", exact: true }).click();
  await expect(controls.getByRole("alert")).toContainText("Host restart response disconnected");
  await page.reload(); await openCoding(page);
  await panel(page).getByText("Agent host", { exact: true }).click();
  await controls.getByRole("button", { name: "Restart agent host", exact: true }).click();
  await expect(controls.getByText("Agent host restarted", { exact: true })).toBeVisible();
  const posts = studio.requests.filter(request => request.method === "POST" && request.path === "/api/agent-tasks/runtime-upgrade");
  expect(posts).toHaveLength(2); expect(posts[0]!.body).toEqual(posts[1]!.body);
  expect((posts[0]!.body as { requestId: string }).requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(studio.requests.filter(request => /\/(activate|approve)$/.test(request.path))).toHaveLength(0);
});

test("A failed agent host can explicitly restart from corrected source with a durable replacement request", async ({ page, studio }) => {
  const failedRequestId = "d9f4338d-ce07-468b-9975-7db612d33b4a";
  let intent: AgentRuntimeUpgradeIntentView = { requestId: failedRequestId, targetDigest: "failed-host-release", phase: "failed", error: "The pinned host did not start." }, attempts = 0;
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [] } }));
  studio.reply("GET", "/api/agent-tasks/runtime-upgrade", route => route.fulfill({ json: { intent } }));
  studio.reply("POST", "/api/agent-tasks/runtime-upgrade", route => {
    attempts++;
    if (attempts === 1) return route.fulfill({ json: intent });
    if (attempts === 2) return route.fulfill({ status: 503, json: { error: "Corrected-source restart response disconnected" } });
    intent = { requestId: (route.request().postDataJSON() as { requestId: string }).requestId, replacesRequestId: failedRequestId, targetDigest: "corrected-host-release", phase: attempts === 3 ? "failed" : "ready", ...(attempts === 3 ? { error: "Corrected host temporarily failed to start." } : {}) };
    return route.fulfill({ json: intent });
  });
  const posts = () => studio.requests.filter(request => request.method === "POST" && request.path === "/api/agent-tasks/runtime-upgrade");
  await studio.goto("/graphql"); await openCoding(page);
  await panel(page).getByText("Agent host", { exact: true }).click();
  const controls = panel(page).getByRole("region", { name: "Agent host controls", exact: true });
  const corrected = controls.getByRole("button", { name: "Restart from corrected source", exact: true });
  await expect(controls.getByText("Agent host restart failed", { exact: true })).toBeVisible();
  await expect(corrected).toBeEnabled(); expect(posts()).toHaveLength(0);
  await controls.getByRole("button", { name: "Restart agent host", exact: true }).click();
  await expect.poll(() => posts().length).toBe(1); expect(posts()[0]!.body).toEqual({ requestId: failedRequestId });
  await expect(corrected).toBeEnabled(); await corrected.focus(); await corrected.press("Enter");
  await expect(controls.getByRole("alert")).toContainText("Corrected-source restart response disconnected");
  const replacement = posts()[1]!.body as { requestId: string; replaceFailedRequestId: string };
  expect(replacement.requestId).toMatch(/^[a-f0-9-]{36}$/); expect(replacement.requestId).not.toBe(failedRequestId);
  expect(replacement.replaceFailedRequestId).toBe(failedRequestId);
  await page.reload(); await openCoding(page); await panel(page).getByText("Agent host", { exact: true }).click();
  await expect(corrected).toBeEnabled(); expect(posts()).toHaveLength(2);
  await expect(controls.getByRole("button", { name: "Restart agent host", exact: true })).toBeDisabled();
  await corrected.click();
  await expect(controls.getByText("Corrected host temporarily failed to start.", { exact: true })).toBeVisible();
  expect(posts()).toHaveLength(3); expect(posts()[2]!.body).toEqual(replacement);
  await controls.getByRole("button", { name: "Restart agent host", exact: true }).click();
  await expect(controls.getByText("Agent host restarted", { exact: true })).toBeVisible();
  expect(posts()).toHaveLength(4); expect(posts()[3]!.body).toEqual(replacement);
  await expect(corrected).toHaveCount(0);
  expect(studio.requests.filter(request => /\/(activate|approve)$/.test(request.path))).toHaveLength(0);
});

test("Reviewed inspector edits open a durable Coding task without approving or losing the draft", async ({ page, studio }) => {
  let current: CodingTask | undefined, attempts = 0;
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: current ? [current] : [] } }));
  studio.reply("POST", "/api/edits/batch/coding-review", route => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: "Coding host temporarily unavailable" } });
    current = task(); return route.fulfill({ json: current });
  });
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, route => route.fulfill({ json: { task: current, events: progress } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/proposal`, route => route.fulfill({ json: proposal }));
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.locator('[data-resource-id="lambda:fixture-0"]').click();
  const description = page.getByRole("region", { name: "Node description" });
  await description.locator("summary").click();
  await description.getByRole("textbox", { name: "Description", exact: true }).fill("Keep this inspector draft after task handoff.");
  await page.getByRole("button", { name: "Review Changes", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Review as coding task", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Coding host temporarily unavailable");
  await dialog.getByRole("button", { name: "Review as coding task", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Coding", exact: true })).toBeFocused();
  await expect(panel(page).getByRole("combobox", { name: "Saved tasks" })).toHaveValue(taskId);
  await expect(panel(page).getByRole("button", { name: "Approve and apply" })).toBeEnabled();
  const requests = studio.requests.filter(request => request.path === "/api/edits/batch/coding-review");
  expect(requests).toHaveLength(2); expect(requests[0]!.body).toEqual(requests[1]!.body);
  expect((requests[0]!.body as { requestKey: string }).requestKey).toBeTruthy();
  expect(studio.requests.filter(request => /\/(approve|apply)$/.test(request.path))).toHaveLength(0);
  await page.getByRole("button", { name: /^Agent: collapse panel$/ }).click();
  await expect(description.getByRole("textbox", { name: "Description", exact: true })).toHaveValue("Keep this inspector draft after task handoff.");
});

test("Candidate refresh binds the reviewed digest and does not approve changes", async ({ page, studio }) => {
  let current = task("conflicted");
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [current] } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, route => route.fulfill({ json: { task: current, events: progress } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/proposal`, route => route.fulfill({ json: proposal }));
  studio.reply("POST", `/api/agent-tasks/${taskId}/refresh`, route => { current = { ...task("validating"), summary: "Merging saved changes and validating a new candidate." }; return route.fulfill({ json: current }); });
  await studio.goto("/graphql"); await openCoding(page);
  await panel(page).getByRole("button", { name: "Refresh candidate from saved source" }).click();
  await expect(panel(page).getByText("Validating", { exact: true })).toBeVisible();
  expect(studio.requests.find(request => request.path.endsWith("/refresh"))!.body).toEqual({ digest: proposal.digest });
  expect(studio.requests.filter(request => request.path.endsWith("/approve"))).toHaveLength(0);
});

test("Studio source approval and managed restart are separate explicit actions", async ({ page, studio }) => {
  let current: CodingTask = { ...task(), activation: "restart_required" };
  const runtimeProposal: CodingProposal = { ...proposal, activation: "restart_required" };
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [current] } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, route => route.fulfill({ json: { task: current, events: progress } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/proposal`, route => route.fulfill({ json: runtimeProposal }));
  studio.reply("POST", `/api/agent-tasks/${taskId}/approve`, route => { current = { ...task("completed"), activation: "restart_required" }; return route.fulfill({ json: current }); });
  studio.reply("POST", `/api/agent-tasks/${taskId}/activate`, route => { current = { ...current, lastSeq: 5, runtimeActivation: { status: "ready", detail: "Studio restarted from accepted source." } }; return route.fulfill({ json: current }); });
  await studio.goto("/graphql"); await openCoding(page);
  await expect(panel(page).getByText(/Source approval and restart are separate actions/)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Restart Studio", exact: true })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Approve and apply" }).click();
  await expect(panel(page).getByRole("button", { name: "Restart Studio", exact: true })).toBeEnabled();
  expect(studio.requests.filter(request => request.path.endsWith("/activate"))).toHaveLength(0);
  await panel(page).getByRole("button", { name: "Restart Studio", exact: true }).click();
  await expect(panel(page).getByText("Studio restarted from accepted source.", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("link", { name: "Reload Studio", exact: true })).toHaveAttribute("href", "http://127.0.0.1:4592/graphql");
  expect(studio.requests.find(request => request.path.endsWith("/activate"))!.body).toEqual({ digest: proposal.digest });
  expect(studio.requests.filter(request => request.path.endsWith("/approve"))).toHaveLength(1);
});

test("A restart disconnect offers reload while retaining the applied source review", async ({ page, studio }) => {
  const current: CodingTask = { ...task("completed"), activation: "restart_required", runtimeActivation: { status: "starting", detail: "Studio is restarting. Task history remains available." } };
  let disconnected = false;
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill(disconnected ? { status: 503, json: { error: "Studio is restarting" } } : { json: { tasks: [current] } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, route => route.fulfill({ json: { task: current, events: progress } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/proposal`, route => route.fulfill({ json: { ...proposal, activation: "restart_required" } }));
  await studio.goto("/graphql"); await openCoding(page);
  await expect(panel(page).getByRole("button", { name: "Restarting Studio…", exact: true })).toBeDisabled();
  disconnected = true; await panel(page).getByRole("button", { name: "Refresh tasks", exact: true }).click();
  await expect(panel(page).getByRole("link", { name: "Reload Studio", exact: true })).toBeVisible();
  await expect(panel(page).getByRole("region", { name: /^Changes to/ })).toContainText("return 'after'");
  expect(studio.requests.filter(request => /\/(approve|activate)$/.test(request.path))).toHaveLength(0);
});

test("Source recovery requires an explicit typed decision bound to inspected source", async ({ page, studio }) => {
  let unresolved = true;
  const recovery = { id: "fixture-recovery", taskId, proposalDigest: proposal.digest, createdAt: now, fingerprint: "inspected-fingerprint", status: "conflicted", files: [{ path: "handler.ts", state: "written" }] };
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [] } }));
  studio.reply("GET", "/api/agent-tasks/recovery", route => route.fulfill({ json: { coordination: { status: unresolved ? "recovery_required" : "ready", epoch: "fixture" }, recoveries: unresolved ? [recovery] : [] } }));
  studio.reply("POST", "/api/agent-tasks/recovery/fixture-recovery", route => { unresolved = false; return route.fulfill({ json: { journalId: recovery.id, proposalDigest: proposal.digest, status: "restored", paths: ["handler.ts"], message: "Original source restored." } }); });
  await studio.goto("/graphql"); await openCoding(page);
  const restore = panel(page).getByRole("button", { name: "Restore inspected source" });
  await expect(restore).toBeDisabled();
  await panel(page).getByRole("textbox", { name: "Type RESTORE SOURCE" }).fill("RESTORE SOURCE");
  await restore.click(); await expect(panel(page).getByText("Original source restored.", { exact: true })).toBeVisible();
  expect(studio.requests.find(request => request.path === "/api/agent-tasks/recovery/fixture-recovery")!.body).toEqual({ approval: "RESTORE SOURCE", fingerprint: "inspected-fingerprint" });
});

for (const width of [1440, 390]) test(`Coding request, exact diff approval and reload recovery at ${width}px`, async ({ page, studio }, info) => {
  await page.setViewportSize({ width, height: 900 });
  let current: CodingTask | undefined;
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: current ? [current] : [] } }));
  studio.reply("POST", "/api/agent-tasks", route => { current = task(); return route.fulfill({ json: current }); });
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, (route, url) => route.fulfill({ json: { task: current, events: progress.filter(event => event.seq > Number(url.searchParams.get("after"))) } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/proposal`, route => route.fulfill({ json: { ...proposal, architecturePreview: { version: 1, proposalDigest: proposal.digest, baselineDigest: proposal.baselineDigest, candidateDigest: proposal.candidateDigest, status: "partial", modes: [{ mode: "prod", status: "partial", changes: [{ entity: "route", id: "route:http:/new", kind: "add", fields: ["id"], implications: [] }], diagnostics: ["Conditional deployment inputs are unknown."] }], limitations: ["Advisory declaration preview; no AWS resources are changed."] } } }));
  studio.reply("POST", `/api/agent-tasks/${taskId}/approve`, route => { current = task("completed"); return route.fulfill({ json: current }); });
  studio.reply("POST", `/api/agent-tasks/${taskId}/cleanup`, route => { current = { ...task("completed"), workspaceDisposition: "source_only" }; return route.fulfill({ json: current }); });
  await studio.goto("/graphql"); await openCoding(page);
  await expect(panel(page).getByRole("combobox", { name: "Saved tasks" })).toContainText("No coding tasks yet");
  const prompt = panel(page).getByRole("textbox", { name: "Coding request" });
  await prompt.fill("Update the example handler and validate it.");
  await panel(page).getByText("Inspect task context", { exact: true }).click();
  await expect(panel(page).getByLabel("Coding task context")).toContainText('"schemaVersion": 1');
  await expect(panel(page).getByLabel("Coding task context")).toContainText('"omitted"');
  await panel(page).getByRole("combobox", { name: "Coding model" }).selectOption("fixture-model");
  await prompt.press("Control+Enter");
  await expect(panel(page).getByRole("region", { name: /^Changes to/ })).toContainText("return 'after'");
  await expect(panel(page).getByText("Ready for review", { exact: true })).toBeVisible();
  const submitted = studio.requests.find(request => request.method === "POST" && request.path === "/api/agent-tasks")!.body as { provider: string; model: string; context: string; prompt: string; requestKey: string };
  expect(submitted.provider).toBe("codex"); expect(submitted.model).toBe("fixture-model"); expect(submitted.prompt).toBe(task().prompt);
  expect(submitted.requestKey).toBeTruthy(); expect(JSON.parse(submitted.context).schemaVersion).toBe(1);
  expect(studio.requests.some(request => request.path.endsWith("/approve"))).toBe(false);
  await panel(page).getByText("Proposed architecture · partial", { exact: true }).click();
  await expect(panel(page).getByRole("region", { name: "Production architecture changes" })).toContainText("route:http:/new");
  await expect(panel(page).getByText("Conditional deployment inputs are unknown.", { exact: true })).toBeVisible();
  await assertAccessible(page);
  await page.screenshot({ path: info.outputPath(`coding-review-${width}.png`), fullPage: true });
  await panel(page).getByRole("button", { name: "Approve and apply" }).click();
  await expect(panel(page).getByText("Approved changes are in the project. Studio will refresh from saved source.")).toBeVisible();
  expect(studio.requests.find(request => request.path.endsWith("/approve"))!.body).toEqual({ digest: "approved-digest" });
  await page.reload(); await openCoding(page);
  await expect(panel(page).getByRole("combobox", { name: "Saved tasks" })).toHaveValue(taskId);
  await expect(panel(page).getByText("Completed", { exact: true })).toBeVisible();
  await panel(page).getByRole("button", { name: "Clean up temporary task files" }).click();
  await expect(panel(page).getByText("Temporary execution files were cleaned up. Source review and recovery evidence remain available.")).toBeVisible();
  await expect(panel(page).getByRole("region", { name: /^Changes to/ })).toContainText("return 'after'");
  expect(studio.requests.filter(request => request.method === "POST" && request.path === "/api/agent-tasks")).toHaveLength(1);
});

test("Selected validation paths and the captured request remain identical across submission retry", async ({ page, studio }) => {
  let attempts = 0, current: CodingTask | undefined;
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: current ? [current] : [] } }));
  studio.reply("POST", "/api/agent-tasks", route => { attempts++; if (attempts === 1) return route.fulfill({ status: 503, json: { error: "Temporary host disconnect" } }); current = task("queued"); return route.fulfill({ json: current }); });
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, route => route.fulfill({ json: { task: current, events: progress } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/proposal`, route => route.fulfill({ json: proposal }));
  await studio.goto("/graphql"); await openCoding(page);
  await panel(page).getByRole("textbox", { name: "Coding request" }).fill("Run only the selected source tests after editing.");
  await panel(page).getByRole("combobox", { name: "Final validation" }).selectOption("tests");
  await expect(panel(page).getByRole("button", { name: "Start coding task", exact: true })).toBeDisabled();
  await panel(page).getByRole("textbox", { name: "Test paths" }).fill("test/example.test.ts\ntest/second.test.ts");
  await panel(page).getByRole("button", { name: "Start coding task", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toContainText("Temporary host disconnect");
  await panel(page).getByRole("button", { name: "Start coding task", exact: true }).click();
  await expect(panel(page).getByText("Queued", { exact: true })).toBeVisible();
  const requests = studio.requests.filter(request => request.method === "POST" && request.path === "/api/agent-tasks");
  expect(requests).toHaveLength(2); expect(requests[0]!.body).toEqual(requests[1]!.body);
  expect((requests[1]!.body as { validation: unknown }).validation).toEqual({ kind: "tests", paths: ["test/example.test.ts", "test/second.test.ts"] });
});

test("Browser reload observes a running task; only explicit Cancel cancels it", async ({ page, studio }) => {
  let current = { ...task("running"), proposalDigest: undefined };
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [current] } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, (route, url) => route.fulfill({ json: { task: current, events: progress.filter(event => event.seq > Number(url.searchParams.get("after"))) } }));
  studio.reply("POST", `/api/agent-tasks/${taskId}/cancel`, route => { current = { ...current, status: "cancelled" }; return route.fulfill({ json: current }); });
  await studio.goto("/graphql"); await openCoding(page);
  await expect(panel(page).getByRole("button", { name: "Cancel task" })).toBeVisible();
  await page.reload(); await openCoding(page);
  expect(studio.requests.filter(request => request.path.endsWith("/cancel"))).toHaveLength(0);
  await panel(page).getByRole("button", { name: "Cancel task" }).click();
  await expect(panel(page).getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Resume task" })).toBeVisible();
  expect(studio.requests.filter(request => request.path.endsWith("/cancel"))).toHaveLength(1);
});

test("Failed validation blocks approval, rejection is explicit, and task read errors can retry", async ({ page, studio }) => {
  let fail = true, current = task();
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill(fail ? { status: 503, json: { error: "Task host temporarily unavailable" } } : { json: { tasks: [current] } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, route => route.fulfill({ json: { task: current, events: progress } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/proposal`, route => route.fulfill({ json: { ...proposal, validation: [{ ...proposal.validation[0], status: "failed", exitCode: 1 }] } }));
  studio.reply("POST", `/api/agent-tasks/${taskId}/reject`, route => { current = task("rejected"); return route.fulfill({ json: current }); });
  await studio.goto("/graphql"); await openCoding(page);
  await expect(panel(page).getByRole("alert")).toContainText("Task host temporarily unavailable");
  fail = false; await panel(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel(page).getByRole("button", { name: "Approve and apply" })).toBeDisabled();
  await expect(panel(page).getByRole("button", { name: "Repair validation failures", exact: true })).toHaveCount(0);
  await expect(panel(page).getByText(/Final validation must pass/)).toBeVisible();
  await panel(page).getByRole("button", { name: "Reject proposal" }).click();
  await expect(panel(page).getByText("Rejected", { exact: true })).toBeVisible();
  expect(studio.requests.filter(request => request.path.endsWith("/approve"))).toHaveLength(0);
});

test("Failed validation repair explicitly resumes the same task without approving the failed proposal", async ({ page, studio }) => {
  let current: CodingTask = { ...task(), canResumeValidation: true };
  let validationStatus: "unavailable" | "failed" = "unavailable";
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [current] } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/events`, route => route.fulfill({ json: { task: current, events: progress } }));
  studio.reply("GET", `/api/agent-tasks/${taskId}/proposal`, route => route.fulfill({ json: { ...proposal, validation: [{ ...proposal.validation[0], status: validationStatus, exitCode: 1, detail: "Example handler test failed." }] } }));
  studio.reply("POST", `/api/agent-tasks/${taskId}/resume`, route => {
    current = { ...current, status: "queued", lastSeq: 5, proposalDigest: undefined, canResumeValidation: false, summary: "Resuming with failed validation evidence." };
    return route.fulfill({ json: current });
  });
  await studio.goto("/graphql"); await openCoding(page);
  await expect(panel(page).getByRole("button", { name: "Approve and apply" })).toBeDisabled();
  await expect(panel(page).getByText("Not verified", { exact: true })).toBeVisible();
  const repair = panel(page).getByRole("button", { name: "Repair validation failures", exact: true });
  await expect(repair).toHaveCount(0);
  validationStatus = "failed"; await panel(page).getByRole("button", { name: "Refresh tasks", exact: true }).click();
  await expect(repair).toBeEnabled();
  await expect(panel(page).getByText(/repaired changes require fresh validation and a new source approval/)).toBeVisible();
  await repair.focus(); await repair.press("Enter");
  await expect(panel(page).getByText("Queued", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("combobox", { name: "Saved tasks" })).toHaveValue(taskId);
  await expect(panel(page).getByRole("region", { name: "Proposed changes", exact: true })).toHaveCount(0);
  expect(studio.requests.filter(request => request.method === "POST" && request.path.startsWith("/api/agent-tasks")).map(request => ({ path: request.path, body: request.body }))).toEqual([{ path: `/api/agent-tasks/${taskId}/resume`, body: {} }]);
});

test("Agent view tabs cycle by keyboard without clearing conversation input", async ({ page, studio }) => {
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [] } }));
  await studio.goto("/graphql"); await openCoding(page);
  const codingTab = page.getByRole("tab", { name: "Coding", exact: true });
  await codingTab.focus(); await codingTab.press("Home");
  await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toBeFocused();
  const prompt = page.getByRole("textbox", { name: "Ask the agent", exact: true }); await prompt.fill("Keep this conversation draft.");
  await page.getByRole("tab", { name: "Conversation", exact: true }).focus(); await page.keyboard.press("End");
  await expect(codingTab).toBeFocused(); await expect(panel(page)).toBeVisible();
  await codingTab.press("ArrowRight");
  await expect(prompt).toHaveValue("Keep this conversation draft.");
});
