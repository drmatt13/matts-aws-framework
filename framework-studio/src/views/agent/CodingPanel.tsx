import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { codingTaskActive, type CodingProvider, type CodingTaskRequest, type CodingValidationPlan } from "../../../shared/agent-runtime";
import { agentLabApi } from "../../agent-lab-api";
import { useCodingTasks } from "../../agent-tasks";
import { codingActivationProblem, codingApprovalProblem, codingDiffLines, codingProgressItems, codingStatusLabel, codingValidationChoice } from "../../coding-presentation";
import { buildSightline } from "../../sightline/build";
import { useSightlineInputs } from "../../sightline/useSightlineInputs";
import { Button } from "../../ui/Button";
import { Select, Textarea, TextInput } from "../../ui/FormControls";
import { Notice } from "../../ui/Surface";
import { SourceDiff } from "../SourceDiff";
import { ArchitecturePreviewPanel } from "./ArchitecturePreviewPanel";
import { CodingRecoveryPanel } from "./CodingRecoveryPanel";
import { CodingHostPanel } from "./CodingHostPanel";

export function CodingPanel({ visible }: { readonly visible: boolean }) {
  const inputs = useSightlineInputs(), coding = useCodingTasks(visible, inputs.snapshot.repositoryRoot);
  const [provider, setProvider] = useState<CodingProvider>("codex"), [models, setModels] = useState({ codex: "", claude: "" });
  const [draft, setDraft] = useState(""), [includeContext, setIncludeContext] = useState(true), [composeOpen, setComposeOpen] = useState(true);
  const [validationKind, setValidationKind] = useState<CodingValidationPlan["kind"]>("project"), [testPaths, setTestPaths] = useState("");
  const submission = useRef<CodingTaskRequest | undefined>(undefined), composer = useRef<HTMLTextAreaElement>(null);
  const status = useQuery({ queryKey: ["agent-lab-status"], queryFn: agentLabApi.status, enabled: visible, retry: false, staleTime: 30_000, refetchOnWindowFocus: false });
  const selectedProvider = status.data?.providers.find(item => item.id === provider);
  const catalog = useQuery({ queryKey: ["agent-lab-models", provider], queryFn: ({ signal }) => agentLabApi.models(provider, signal), enabled: visible && selectedProvider?.available === true, retry: false, staleTime: 60_000, refetchOnWindowFocus: false });
  const model = models[provider], missingModel = !!model && !!catalog.data && !catalog.data.models.some(item => item.id === model);
  const context = useMemo(() => JSON.stringify(buildSightline(inputs)), [inputs]);
  const task = coding.task, proposal = coding.proposal.data;
  const approvalProblem = task && proposal ? codingApprovalProblem(task, proposal) : undefined;
  const activationProblem = task && proposal ? codingActivationProblem(task, proposal) : undefined;
  const progress = useMemo(() => codingProgressItems(coding.events.data?.events ?? []), [coding.events.data?.events]);
  const permission = task?.status === "waiting_for_permission" ? [...(coding.events.data?.events ?? [])].reverse().find(event => event.type === "permission" && typeof event.data.id === "string" && !event.data.decision) : undefined;
  const busy = !!coding.pending;
  const active = coding.list.data?.tasks.some(codingTaskActive) ?? false;
  const error = coding.problem ?? coding.list.error?.message ?? coding.events.error?.message ?? coding.proposal.error?.message;
  const validation = codingValidationChoice(validationKind, testPaths);
  const canSubmit = !!draft.trim() && draft.length <= 16000 && selectedProvider?.available === true && !missingModel && !busy && !!validation.plan;
  const submit = async () => {
    if (!canSubmit) return;
    // A retry keeps the exact captured context as well as the idempotency key.
    submission.current ??= { requestKey: crypto.randomUUID(), provider, prompt: draft.trim(), ...(model ? { model } : {}), ...(includeContext ? { context } : {}), validation: validation.plan };
    if (await coding.submit(submission.current)) {
      setDraft(""); submission.current = undefined; setComposeOpen(false);
    }
  };
  return <section aria-label="Coding tasks" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-sheet p-4 text-label">
    <div className="mx-auto grid w-full max-w-[1000px] gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 gap-1" htmlFor="coding-task-select">Saved tasks
          <Select id="coding-task-select" value={coding.selected ?? ""} disabled={busy || !coding.list.data?.tasks.length} onChange={event => coding.select(event.target.value)}>
            {!coding.list.data?.tasks.length ? <option value="">{coding.list.isPending ? "Loading tasks…" : "No coding tasks yet"}</option> : coding.list.data.tasks.map(item => <option key={item.id} value={item.id}>{codingStatusLabel[item.status]} · {item.prompt.slice(0, 90)}</option>)}
          </Select>
        </label>
        <Button type="button" disabled={busy} onClick={() => { setComposeOpen(true); requestAnimationFrame(() => composer.current?.focus()); }}>New task</Button>
        <Button type="button" variant="quiet" disabled={busy} onClick={coding.retry}>Refresh tasks</Button>
      </div>
      <CodingHostPanel repository={inputs.snapshot.repositoryRoot} visible={visible} active={active} />
      {error ? <Notice role="alert">{error} <Button type="button" variant="link" onClick={coding.retry}>Retry</Button></Notice> : null}
      <CodingRecoveryPanel repository={inputs.snapshot.repositoryRoot} visible={visible} />
      <details open={composeOpen} onToggle={event => setComposeOpen(event.currentTarget.open)} className="rounded-md border border-rule p-3">
        <summary className="cursor-pointer font-semibold">Start a coding task</summary>
        <form className="mt-3 grid gap-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <p className="m-0 text-caption text-graphite">The agent edits a private copy of your saved source. Review and approve its changes before they reach this project.</p>
          <div className="flex flex-wrap gap-3">
            <label className="grid flex-[1_1_160px] gap-1" htmlFor="coding-provider">Coding provider
              <Select id="coding-provider" value={provider} disabled={busy} onChange={event => { setProvider(event.target.value as CodingProvider); submission.current = undefined; }}>
                <option value="codex">Codex</option><option value="claude">Claude</option>
              </Select>
            </label>
            <label className="grid min-w-0 flex-[1_1_180px] gap-1" htmlFor="coding-model">Coding model
              <Select id="coding-model" value={model} disabled={busy || selectedProvider?.available !== true} onChange={event => { setModels(current => ({ ...current, [provider]: event.target.value })); submission.current = undefined; }}>
                <option value="">CLI default</option>
                {catalog.data?.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                {missingModel ? <option value={model}>{model} (unavailable)</option> : null}
              </Select>
            </label>
          </div>
          {status.isPending ? <p role="status" className="m-0 text-caption">Checking coding providers…</p> : status.error || selectedProvider?.available !== true ? <Notice tone="warning">{status.error?.message ?? selectedProvider?.detail ?? "Install and sign in to this CLI to start a task."}</Notice> : null}
          {catalog.error || catalog.data?.problem || missingModel ? <Notice tone="warning">{catalog.error?.message ?? catalog.data?.problem ?? "The selected model is unavailable. Choose another model or CLI default."} <Button type="button" variant="link" onClick={() => void catalog.refetch()}>Refresh models</Button></Notice> : null}
          <label className="grid gap-1" htmlFor="coding-prompt">Coding request
            <Textarea ref={composer} id="coding-prompt" rows={3} maxLength={16000} required value={draft} disabled={busy} aria-describedby="coding-prompt-help" onChange={event => { setDraft(event.target.value); submission.current = undefined; }} onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          </label>
          <p id="coding-prompt-help" className="m-0 text-caption text-graphite">Describe a change and how to validate it. Ctrl+Enter or Command+Enter starts the task.</p>
          <label className="grid gap-1" htmlFor="coding-validation">Final validation<Select id="coding-validation" value={validationKind} disabled={busy} onChange={event => { setValidationKind(event.target.value as CodingValidationPlan["kind"]); submission.current = undefined; }}><option value="project">Project verify or test</option><option value="framework">Framework declarations</option><option value="tests">Selected source tests</option></Select></label>
          {validationKind === "tests" ? <label className="grid gap-1" htmlFor="coding-test-paths">Test paths<Textarea id="coding-test-paths" rows={3} value={testPaths} disabled={busy} aria-describedby="coding-validation-help" aria-invalid={!!validation.problem} onChange={event => { setTestPaths(event.target.value); submission.current = undefined; }} placeholder="framework-studio/test/example.test.ts" /></label> : null}
          <p id="coding-validation-help" className="m-0 text-caption text-graphite">{validation.problem ?? (validationKind === "project" ? "The host runs the project’s verify script, or test when verify is absent, inside the task’s execution restrictions." : validationKind === "framework" ? "Runs framework:check. Evidence covers declaration checks only." : "Runs only the selected test files. Passing these checks provides evidence for those tests; network and operational permissions stay restricted.")}</p>
          <label className="flex items-center gap-2"><TextInput type="checkbox" checked={includeContext} disabled={busy} onChange={event => { setIncludeContext(event.target.checked); submission.current = undefined; }} />Include current Studio context</label>
          {includeContext ? <details className="rounded-md border border-rule p-2"><summary className="cursor-pointer text-caption font-semibold">Inspect task context</summary><p className="mb-2 text-caption text-graphite">{submission.current ? "This retry keeps the originally captured context." : "Context is captured when you start the task."} Declared source, available observations and their freshness remain separate. Context does not authorize operations.</p><pre aria-label="Coding task context" tabIndex={0} className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap font-mono text-caption wrap-anywhere">{JSON.stringify(JSON.parse(submission.current?.context ?? context), null, 2)}</pre></details> : null}
          {inputs.source.dirty ? <p className="m-0 text-caption text-graphite">Unsaved Studio drafts are excluded. The task starts from saved project files.</p> : null}
          {active ? <p role="status" className="m-0 text-caption">Another coding task is active. New tasks wait for execution capacity.</p> : null}
          <div><Button type="submit" variant="primary" disabled={!canSubmit}>{coding.pending === "Starting task" ? "Starting…" : "Start coding task"}</Button></div>
        </form>
      </details>
      {!task && !coding.list.isPending && !coding.list.error ? <p className="m-0 text-graphite">Start with a focused source change and a validation command. Your task history and proposals stay available after a reload.</p> : null}
      {task ? <article aria-label="Selected coding task" className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 mr-auto text-body font-semibold" role="status">{codingStatusLabel[task.status]}</h3>
          {codingTaskActive(task) && task.status !== "integrating" ? <Button type="button" disabled={busy || task.cancelRequested} onClick={() => void coding.cancel()}>{task.cancelRequested ? "Cancellation requested" : "Cancel task"}</Button> : null}
          {["interrupted", "failed", "cancelled"].includes(task.status) ? <Button type="button" disabled={busy} onClick={() => void coding.resume()}>Resume task</Button> : null}
        </div>
        <p className="m-0 whitespace-pre-wrap wrap-anywhere">{task.prompt}</p>
        {task.summary ? <p className="m-0 text-caption text-graphite">{task.summary}</p> : null}
        {coding.pending ? <p role="status" className="m-0 text-caption">{coding.pending}…</p> : null}
        {task.sourceOutcome === "applied" ? <Notice tone="success">Approved changes are in the project. Studio will refresh from saved source.</Notice> : null}
        {task.sourceOutcome === "restored" ? <Notice tone="warning">Integration stopped and its writes were restored. The task’s changes are not applied.</Notice> : null}
        {task.sourceOutcome === "kept" ? <Notice tone="warning">Current source was kept after recovery. It is not confirmed as the reviewed proposal.</Notice> : null}
        {task.workspaceDisposition === "source_only" ? <p className="m-0 text-caption text-graphite">Temporary execution files were cleaned up. Source review and recovery evidence remain available.</p> : ["completed", "rejected"].includes(task.status) ? <div><Button type="button" disabled={busy} onClick={() => void coding.cleanup()}>Clean up temporary task files</Button><p className="mb-0 mt-1 text-caption text-graphite">Releases the private working copy and runtime files while retaining review and recovery evidence.</p></div> : null}
        {task.status === "conflicted" ? <Notice tone="warning">Saved source changed. This proposal has not been applied; refresh the candidate and validate it against current source.</Notice> : null}
        {permission ? <Notice tone="warning"><p className="mt-0">{typeof permission.data.description === "string" ? permission.data.description : "The agent requests permission to continue within this task’s execution policy."}</p><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={() => void coding.permission(String(permission.data.id), true)}>Allow task action</Button><Button type="button" disabled={busy} onClick={() => void coding.permission(String(permission.data.id), false)}>Deny task action</Button></div></Notice> : null}
        {task.activation === "dependency_install_required" ? <Notice tone="warning">Dependency changes need a separate installation before application.</Notice> : null}
        {task.status === "completed" && task.sourceOutcome === "applied" && task.activation === "restart_required" ? <Notice tone={task.runtimeActivation?.status === "ready" ? "success" : "warning"}>
          <p className="mt-0">{task.runtimeActivation?.detail ?? "Studio source changes are applied. Restart Studio to activate them; your task history and review remain available."}</p>
          <div className="flex flex-wrap items-center gap-2">
            {task.runtimeActivation?.status !== "ready" ? <Button type="button" disabled={busy || !proposal || !!activationProblem || !!error} onClick={() => void coding.activate()}>{task.runtimeActivation?.status === "starting" ? "Restarting Studio…" : "Restart Studio"}</Button> : null}
            {task.runtimeActivation?.status === "ready" || !!error ? <a className="text-caption underline underline-offset-2" href={window.location.href}>Reload Studio</a> : null}
          </div>
        </Notice> : null}
        <details className="rounded-md border border-rule p-3" open>
          <summary className="cursor-pointer font-semibold">Progress</summary>
          {coding.events.isPending ? <p role="status" className="mb-0 text-caption">Loading task progress…</p> : !coding.events.data?.events.length ? <p className="mb-0 text-caption text-graphite">Waiting for the first task event.</p> : <ol aria-label="Task progress" className="mb-0 grid max-h-[240px] gap-2 overflow-y-auto pl-5">
            {progress.map(item => <li key={item.seq}><span className="text-caption font-semibold">{item.type}</span><pre className="m-0 whitespace-pre-wrap font-mono text-caption wrap-anywhere">{item.text}</pre></li>)}
          </ol>}
        </details>
        {task.proposalDigest && coding.proposal.isPending ? <p role="status" className="m-0">Loading proposed changes…</p> : null}
        {proposal ? <section aria-label="Proposed changes" className="grid gap-3">
          <h3 className="m-0 text-body font-semibold">Review {proposal.changes.length} changed {proposal.changes.length === 1 ? "file" : "files"}</h3>
          {proposal.validation.map((check, at) => <Notice key={at} tone={check.status === "passed" ? "success" : "warning"}><strong>{check.status === "passed" ? "Passed" : check.status === "failed" ? "Failed" : "Not verified"}</strong>: <code>{check.command}</code>{check.detail ? ` — ${check.detail}` : ""}</Notice>)}
          {!proposal.validation.length ? <Notice tone="warning">No validation evidence is available for this proposal.</Notice> : null}
          {task.status === "awaiting_review" && task.canResumeValidation === true && proposal.validation.some(check => check.status === "failed") ? <div>
            <Button type="button" disabled={busy || !!error} onClick={() => void coding.resume()}>Repair validation failures</Button>
            <p className="mb-0 mt-1 text-caption text-graphite">Resumes this agent in its retained working copy with the failed validation evidence. The repaired changes require fresh validation and a new source approval.</p>
          </div> : null}
          {proposal.activation === "restart_required" && task.sourceOutcome !== "applied" ? <Notice tone="warning">Apply these Studio changes, then use Restart Studio to activate them. Source approval and restart are separate actions.</Notice> : proposal.activation === "dependency_install_required" ? <Notice tone="warning">This proposal is retained. Applying dependency changes requires a separate installation and validation.</Notice> : null}
          {proposal.limitations.length ? <ul className="m-0 grid gap-1 pl-5 text-caption text-graphite">{proposal.limitations.map((limit, at) => <li key={at}>{limit}</li>)}</ul> : null}
          {proposal.architecturePreview ? <ArchitecturePreviewPanel preview={proposal.architecturePreview} digest={proposal.digest} /> : null}
          {proposal.changes.map(change => <div key={change.path} className="grid gap-1">
            <SourceDiff file={change.path} lines={codingDiffLines(change.diff)} note={change.binary ? `${change.kind} · binary file` : change.kind} />
            {change.beforeMode !== change.afterMode ? <p className="m-0 text-caption text-graphite">File mode: {change.beforeMode?.toString(8) ?? "absent"} → {change.afterMode?.toString(8) ?? "absent"}</p> : null}
          </div>)}
          {task.status === "awaiting_review" ? <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="primary" disabled={busy || !!error || !!approvalProblem} onClick={() => void coding.approve()}>Approve and apply</Button>
            <Button type="button" disabled={busy} onClick={() => void coding.reject()}>Reject proposal</Button>
            <span className="text-caption text-graphite">{approvalProblem ?? "Applies exactly this reviewed proposal to saved source."}</span>
          </div> : null}
          {["awaiting_review", "conflicted"].includes(task.status) ? <div><Button type="button" disabled={busy || !!error} onClick={() => void coding.refresh()}>Refresh candidate from saved source</Button><p className="mb-0 mt-1 text-caption text-graphite">Merges non-overlapping saved edits into a new candidate, then validates and creates a new review. Conflicts preserve both versions.</p></div> : null}
        </section> : null}
      </article> : null}
    </div>
  </section>;
}
