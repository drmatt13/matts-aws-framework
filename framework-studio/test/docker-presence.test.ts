import assert from "./support/assert";
import { test } from "node:test";
import { dockerPresence, type DockerStatusView } from "../shared/machine";
import type { DockerView } from "../shared/deploy";

const observed = (docker: DockerView): DockerStatusView => ({ docker, checks: [], observedAt: "2026-11-04T12:00:00.000Z" });
const stopped = observed({ engine: "stopped", desktop: true });
const running = observed({ engine: "running", desktop: true });

const cases: readonly { name: string; input: Parameters<typeof dockerPresence>[0]; want: { label: string; tone: string; action: string } }[] = [
  { name: "before the first observation it does not guess", input: { starting: false },
    want: { label: "Checking Docker…", tone: "unknown", action: "none" } },
  { name: "a running engine needs nothing", input: { status: running, starting: false },
    want: { label: "Docker running", tone: "ok", action: "none" } },
  { name: "a stopped engine with Desktop can be started", input: { status: stopped, starting: false },
    want: { label: "Docker stopped", tone: "warn", action: "start" } },
  { name: "a stopped engine without Desktop cannot be started from Studio", input: { status: observed({ engine: "stopped", desktop: false }), starting: false },
    want: { label: "Docker stopped", tone: "warn", action: "check" } },
  { name: "missing Docker links to installation", input: { status: observed({ engine: "missing", desktop: false }), starting: false },
    want: { label: "Docker not installed", tone: "warn", action: "install" } },
  { name: "an unclear answer is never described as stopped", input: { status: observed({ engine: "unknown", desktop: true, problem: "permission denied" }), starting: false },
    want: { label: "Docker status unknown", tone: "unknown", action: "check" } },
  { name: "a running startup replaces the stopped state and its Start action", input: { status: stopped, starting: true },
    want: { label: "Starting Docker…", tone: "busy", action: "none" } },
  { name: "evidence of a running engine outranks a startup still finishing", input: { status: running, starting: true },
    want: { label: "Docker running", tone: "ok", action: "none" } },
  { name: "a failed read does not claim any engine state", input: { status: stopped, starting: false, problem: { message: "Failed to fetch" } },
    want: { label: "Can't check Docker", tone: "unknown", action: "check" } },
  { name: "a server without the route asks for a restart, which Check again cannot fix", input: { starting: false, problem: { status: 404, message: "Restart npm run studio" } },
    want: { label: "Restart Studio to check Docker", tone: "unknown", action: "none" } },
  { name: "a page holding an old session token asks for a reload", input: { starting: false, problem: { status: 401, message: "Reload the page" } },
    want: { label: "Reload Studio to check Docker", tone: "unknown", action: "none" } },
];

for (const { name, input, want } of cases) test(name, () => {
  const { label, tone, action } = dockerPresence(input);
  assert.deepEqual({ label, tone, action }, want);
});

test("only a trustworthy observation exposes an engine for job history to compare against", () => {
  assert.equal(dockerPresence({ status: stopped, starting: false }).engine, "stopped");
  assert.equal(dockerPresence({ status: stopped, starting: false, problem: { message: "Failed to fetch" } }).engine, undefined);
  assert.equal(dockerPresence({ starting: false }).engine, undefined);
});

test("the reason travels with states the label cannot explain", () => {
  assert.equal(dockerPresence({ status: observed({ engine: "unknown", desktop: true, problem: "permission denied" }), starting: false }).detail, "permission denied");
  assert.equal(dockerPresence({ starting: false, problem: { status: 404, message: "Restart npm run studio" } }).detail, "Restart npm run studio");
  assert.equal(dockerPresence({ status: stopped, starting: false }).detail, undefined);
});
