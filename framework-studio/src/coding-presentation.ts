import type { DiffLine } from "../shared/api";
import type { CodingEvent, CodingProposal, CodingTask, CodingTaskStatus, CodingValidationPlan } from "../shared/agent-runtime";

export function codingValidationChoice(kind: CodingValidationPlan["kind"], text: string): { plan?: CodingValidationPlan; problem?: string } {
  if (kind !== "tests") return { plan: { kind } };
  const paths = [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  if (!paths.length || paths.length > 20) return { problem: "Enter 1–20 repository-relative test paths, one per line." };
  if (paths.some(name => name.length > 1000 || /^[-/\\]/.test(name) || /[\x00-\x1f\\:]/.test(name) || name.split("/").some(part => !part || part === "." || part === ".."))) return { problem: "Test paths must stay inside this project and identify source files." };
  return { plan: { kind, paths } };
}

export const codingStatusLabel: Record<CodingTaskStatus, string> = {
  queued: "Queued", preparing: "Preparing workspace", running: "Coding", validating: "Validating", waiting_for_permission: "Permission required",
  awaiting_review: "Ready for review", conflicted: "Source changed", integrating: "Applying approved files", completed: "Completed",
  interrupted: "Interrupted", failed: "Failed", cancelled: "Cancelled", rejected: "Rejected", recovery_required: "Source recovery required",
};
export function codingApprovalProblem(task: CodingTask, proposal: CodingProposal): string | undefined {
  if (task.id !== proposal.taskId || task.proposalDigest !== proposal.digest) return "The reviewed proposal no longer matches this task. Refresh before applying.";
  if (task.status !== "awaiting_review") return "This task is not awaiting source approval.";
  if (!proposal.changes.length) return "There are no source changes to apply.";
  if (proposal.activation === "dependency_install_required") return "Dependency changes need a separate installation before this proposal can be applied.";
  if (!proposal.validation.length || proposal.validation.some(check => check.status !== "passed" || check.candidateDigest !== proposal.candidateDigest)) return "Final validation must pass against these exact proposed files before application.";
  return undefined;
}
export function codingActivationProblem(task: CodingTask, proposal: CodingProposal): string | undefined {
  if (task.id !== proposal.taskId || task.proposalDigest !== proposal.digest) return "Refresh the applied proposal before restarting Studio.";
  if (task.status !== "completed" || task.sourceOutcome !== "applied" || task.activation !== "restart_required" || proposal.activation !== "restart_required") return "Apply the reviewed Studio source changes before requesting restart.";
  if (task.runtimeActivation?.status === "starting") return "Studio restart is already in progress.";
  if (task.runtimeActivation?.status === "ready") return "Studio has restarted. Reload this page to reconnect.";
  return undefined;
}
export function mergeCodingEvents(before: readonly CodingEvent[], next: readonly CodingEvent[]): readonly CodingEvent[] {
  const events = new Map(before.map(event => [event.seq, event]));
  for (const event of next) events.set(event.seq, event);
  return [...events.values()].sort((a, b) => a.seq - b.seq).slice(-1000);
}
export interface CodingProgressItem { readonly seq: number; readonly type: CodingEvent["type"]; readonly text: string }
/** Provider message events are text deltas. Keep their exact whitespace and item boundaries. */
export function codingProgressItems(events: readonly CodingEvent[]): readonly CodingProgressItem[] {
  const rows: CodingProgressItem[] = [];
  let previous: CodingEvent | undefined;
  for (const event of events) {
    const text = codingEventText(event), last = rows.at(-1);
    if (last && event.type === "message" && previous?.type === "message" && event.taskId === previous.taskId && event.data.itemId === previous.data.itemId && typeof event.data.text === "string" && typeof previous.data.text === "string") {
      const joined = last.text + text;
      rows[rows.length - 1] = { ...last, text: joined.length > 32_000 ? `…${joined.slice(-31_999)}` : joined };
    } else rows.push({ seq: event.seq, type: event.type, text });
    previous = event;
  }
  return rows.slice(-100);
}
/** The host owns diff generation; the browser only presents its unified hunks. */
export function codingDiffLines(unified: string): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0, newLine = 0, hunk: string | undefined, inHunk = false;
  for (const text of unified.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); hunk = text; inHunk = true; continue; }
    if (!inHunk) continue;
    if (text.startsWith("+")) lines.push({ kind: "add", text: text.slice(1), newLine: newLine++, ...(hunk ? { hunk } : {}) });
    else if (text.startsWith("-")) lines.push({ kind: "remove", text: text.slice(1), oldLine: oldLine++, ...(hunk ? { hunk } : {}) });
    else if (text.startsWith(" ")) lines.push({ kind: "context", text: text.slice(1), oldLine: oldLine++, newLine: newLine++, ...(hunk ? { hunk } : {}) });
    else if (text.startsWith("\\")) lines.push({ kind: "context", text });
    else continue;
    hunk = undefined;
  }
  return lines;
}
export function codingEventText(event: CodingEvent): string {
  const { text, message, summary, output, stdout, stderr, description, status, command, reason, phase, exitCode } = event.data;
  const commandText = typeof command === "string" ? command : Array.isArray(command) ? command.filter(item => typeof item === "string").join(" ") : undefined;
  const stream = [stdout, stderr].filter(value => typeof value === "string" && value).join("\n");
  const contents = typeof text === "string" ? text : typeof message === "string" ? message : typeof output === "string" ? output : typeof summary === "string" ? summary : stream ? [commandText, stream].filter(Boolean).join("\n") : commandText ?? (typeof description === "string" ? description : typeof reason === "string" ? reason : typeof phase === "string" ? phase.replaceAll("_", " ") : typeof status === "string" ? status.replaceAll("_", " ") : event.type);
  return `${contents}${typeof exitCode === "number" ? ` (exit ${exitCode})` : ""}`.slice(0, 8000);
}
