import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, before, mock, test } from "node:test";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import type { DomainDnsReview } from "../shared/domain-operations";
const require = createRequire(import.meta.url);
let ui: typeof import("@testing-library/react"), view: typeof import("../src/views/DomainOperations"), dom: { window: Window & typeof globalThis };
const selection = { profile: "campaign", deployment: "campaign-prod", region: "us-east-1" };
const context = { ...selection, account: "111122223333", observedAt: "2026-10-23T08:00:00Z" };
const current = { Name: "app.example.com.", Type: "CNAME" as const, TTL: 600, ResourceRecords: [{ Value: "old.cloudfront.net." }] };
const desired = { ...current, TTL: 300, ResourceRecords: [{ Value: "downed123.cloudfront.net." }] };
const review: DomainDnsReview = { id: "review-fixture", context, sourceHash: "source-1", createdAt: context.observedAt, expiresAt: "2099-01-01T00:00:00Z", purpose: "frontend", zone: { id: "ZOWNED123", name: "example.com", nameservers: ["ns1.example.net"] }, hostname: "app.example.com", target: "downed123.cloudfront.net", current, desired, dependencies: ["Verified owned stack campaign-prod-Website", "Public delegation matches hosted zone ZOWNED123"], risks: ["Production routing changes; cached answers can persist."], confirmation: "Change production DNS app.example.com in ZOWNED123 account 111122223333", changeBatch: { Comment: "Fixture review", Changes: [{ Action: "DELETE", ResourceRecordSet: current }, { Action: "CREATE", ResourceRecordSet: desired }] } };
before(async () => {
  const { JSDOM } = require("jsdom"); dom = new JSDOM(`<!doctype html><html><head><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/" });
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLDialogElement", "Element", "Node", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); view = await import("../src/views/DomainOperations");
});
afterEach(() => { ui.cleanup(); mock.restoreAll(); }); after(() => dom.window.close());
function mount(sourceBusy = false) { return ui.render(require("react").createElement(view.DomainOperationsPanel, { selection, sourceBusy, sourceRevision: "source-1" })); }
test("managed DNS shows exact current/desired records and requires operation-specific production confirmation; errors stay in modal", async () => {
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); if (url.endsWith("/history")) return Response.json([]); if (url.includes("/domain-dns?")) return Response.json({ context, sourceHash: "source-1", domains: [], zones: [{ id: "ZOWNED123", name: "example.com", matching: ["frontend"] }] }); if (url.endsWith("/review")) return Response.json(review); if (url.endsWith("/apply")) return Response.json({ error: "Current DNS changed. Nothing was submitted; review again." }, { status: 409 }); throw new Error(`Unexpected ${url}`); });
  const mounted = mount(); ui.fireEvent.click(mounted.getByRole("button", { name: "Discover managed DNS zones" }));
  await mounted.findByRole("option", { name: "example.com · ZOWNED123" }); ui.fireEvent.change(mounted.getByLabelText("Managed DNS zone"), { target: { value: "ZOWNED123" } }); ui.fireEvent.click(mounted.getByRole("button", { name: "Review exact production DNS change" }));
  const dialog = await mounted.findByRole("dialog", { name: "Review production DNS routing" }); const within = ui.within(dialog); const apply = within.getByRole("button", { name: "Apply this production DNS change" }) as HTMLButtonElement;
  assert.match(dialog.textContent!, /old.cloudfront.net/); assert.match(dialog.textContent!, /downed123.cloudfront.net/); assert.match(dialog.textContent!, /111122223333/); assert.match(dialog.textContent!, /DELETE/); assert.equal(apply.disabled, true);
  ui.fireEvent.change(within.getByLabelText("Confirm exact production DNS change"), { target: { value: "yes" } }); assert.equal(apply.disabled, true); assert.equal(calls.filter(url => url.endsWith("/apply")).length, 0);
  ui.fireEvent.change(within.getByLabelText("Confirm exact production DNS change"), { target: { value: review.confirmation } }); assert.equal(apply.disabled, false); ui.fireEvent.click(apply);
  await ui.waitFor(() => assert.match(within.getByRole("alert").textContent!, /Nothing was submitted/)); assert.equal(calls.filter(url => url.endsWith("/apply")).length, 1);
});
test("pending source edits block outbound domain inspection and saved-domain purpose changes discard stale observations", async () => {
  let healthRequests = 0; let resolveHealth: (value: Response) => void = () => {};
  mock.method(globalThis, "fetch", async (url: string) => { if (url.endsWith("/history")) return Response.json([]); healthRequests++; return new Promise<Response>(resolve => { resolveHealth = resolve; }); });
  const mounted = mount(true); const inspect = mounted.getByRole("button", { name: "Inspect live DNS / TLS / HTTP" }) as HTMLButtonElement; assert.equal(inspect.disabled, true); ui.fireEvent.click(inspect); assert.equal(healthRequests, 0);
  mounted.rerender(require("react").createElement(view.DomainOperationsPanel, { selection, sourceBusy: false, sourceRevision: "source-1" })); ui.fireEvent.click(inspect); assert.equal(healthRequests, 1);
  mounted.rerender(require("react").createElement(view.DomainOperationsPanel, { selection: { ...selection, deployment: "other-prod" }, sourceBusy: false, sourceRevision: "source-1" }));
  await ui.act(async () => resolveHealth(Response.json({ context, hostname: "app.example.com", sourceHash: "source-1", observedAt: context.observedAt, dns: { status: "resolved", addresses: ["8.8.8.8"], detail: "Fixture" }, tls: { status: "valid", detail: "Fixture" }, http: { status: "observed", code: 200, detail: "Fixture" }, application: { status: "html-document", detail: "Sign-in unverified" } })));
  assert.equal(mounted.queryByRole("heading", { name: "Observed app.example.com" }), null);
});
