import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { agentLabApi, type AgentLabPlan, type AgentLabProvider } from "../agent-lab-api";
import { agentLabMessage } from "../agent-lab-message";
import { Button } from "../ui/Button";
import { Select, Textarea } from "../ui/FormControls";
import { Card, Notice, WorkspaceToolbar } from "../ui/Surface";
import { pageWidthClasses } from "./DocumentUI";

export function AgentLab() {
  const status = useQuery({
    queryKey: ["agent-lab-status"],
    queryFn: agentLabApi.status,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [provider, setProvider] = useState<AgentLabProvider>("codex");
  // The reviewed demo edit changes this literal without changing the prompt logic.
  const [prompt, setPrompt] = useState(`Change the demo message to "${(agentLabMessage as string) === "Hello from my local coding agent" ? "Ready for another reviewed edit." : "Hello from my local coding agent"}".`);
  const [plan, setPlan] = useState<AgentLabPlan>();
  const [busy, setBusy] = useState<"planning" | "applying">();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!plan) return;
    reviewHeading.current?.focus();
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [plan?.id]);
  const selected = status.data?.providers.find((entry) => entry.id === provider);
  const expired = !!plan && now >= Date.parse(plan.expiresAt);
  const locked = !!busy || status.data?.busy === true;

  const resetReview = () => {
    setPlan(undefined);
    setError(undefined);
    setSuccess(undefined);
  };
  const generatePlan = async (event: FormEvent) => {
    event.preventDefault();
    if (locked || !selected?.available || !prompt.trim()) return;
    resetReview();
    setBusy("planning");
    try {
      const result = await agentLabApi.plan(provider, prompt.trim());
      if (mounted.current) setPlan(result);
    } catch (problem) {
      if (mounted.current) setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      if (mounted.current) {
        setBusy(undefined);
        void status.refetch();
      }
    }
  };
  const applyPlan = async () => {
    if (!plan || locked || expired) return;
    setError(undefined);
    setSuccess(undefined);
    setBusy("applying");
    try {
      const result = await agentLabApi.apply(plan.id);
      if (mounted.current) {
        setPlan(undefined);
        setPrompt("");
        setSuccess(result.message);
      }
    } catch (problem) {
      if (mounted.current) {
        setPlan(undefined);
        setError(problem instanceof Error ? problem.message : String(problem));
      }
    } finally {
      if (mounted.current) {
        setBusy(undefined);
        void status.refetch();
      }
    }
  };

  return (
    <div className="min-h-0 overflow-auto">
      <WorkspaceToolbar className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0 font-condensed text-step1 font-semibold">Local agent test</h1>
        <span className="text-caption text-graphite">Plan → review diff → apply</span>
      </WorkspaceToolbar>
      <div className={`${pageWidthClasses} grid gap-4 py-4`}>
        <Notice tone="neutral">
          This experiment can change one demo message in Studio source. The local CLI proposes a
          plan; Apply saves the reviewed change without another model call. Planning uses your
          provider account and may consume credits or subscription usage.
        </Notice>
        <Card className="grid gap-2" aria-labelledby="agent-lab-current">
          <h2 id="agent-lab-current" className="m-0 text-body font-semibold">Current demo message</h2>
          <p className="m-0 text-step1" data-testid="agent-lab-message">{agentLabMessage}</p>
          <p className="m-0 text-caption text-graphite wrap-anywhere">
            Allowed file: <code>framework-studio/src/agent-lab-message.ts</code>
          </p>
        </Card>
        <Card aria-labelledby="agent-lab-prompt-heading">
          <form className="grid gap-4" onSubmit={(event) => void generatePlan(event)}>
            <h2 id="agent-lab-prompt-heading" className="m-0 text-body font-semibold">1. Generate a plan</h2>
            <div className="flex flex-wrap items-end gap-2">
              <label className="grid min-w-0 flex-[1_1_220px] gap-1 text-label" htmlFor="agent-lab-provider">
                Local coding agent
                <Select id="agent-lab-provider" value={provider} disabled={locked}
                  onChange={(event) => { setProvider(event.target.value as AgentLabProvider); resetReview(); }}>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </Select>
              </label>
              <Button type="button" disabled={!!busy || status.isFetching} onClick={() => void status.refetch()}>
                {status.isFetching ? "Checking…" : "Check installation"}
              </Button>
            </div>
            <p className="m-0 text-caption text-graphite" role="status">
              {status.isPending ? "Checking local CLI installation…" : selected?.detail ?? "No installation details available."}
            </p>
            {status.error ? <Notice role="alert">{status.error.message}</Notice> : null}
            <label className="grid gap-1 text-label" htmlFor="agent-lab-prompt">
              What should the demo message say?
              <Textarea id="agent-lab-prompt" value={prompt} rows={4} maxLength={2000} required
                disabled={locked} aria-describedby="agent-lab-prompt-help"
                onChange={(event) => { setPrompt(event.target.value); resetReview(); }} />
            </label>
            <p id="agent-lab-prompt-help" className="m-0 text-caption text-graphite">
              Only the message can change. Prompts cannot select another file, run commands or deploy.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" disabled={locked || !selected?.available || !prompt.trim()}>
                {busy === "planning" ? "Generating plan…" : "Generate plan"}
              </Button>
              <span role="status" className="text-caption text-graphite">
                {busy === "planning" ? "One bounded CLI request is running. Source stays unchanged until Apply." :
                  status.data?.busy ? "Another plan is running. Check installation to refresh when it finishes." :
                    !plan && !success ? "No plan generated yet." : ""}
              </span>
            </div>
          </form>
        </Card>
        {error ? <Notice role="alert">{error}</Notice> : null}
        {success ? <Notice tone="success" role="status">Saved reviewed change: {success}</Notice> : null}
        {plan ? (
          <Card className="grid gap-3" aria-labelledby="agent-lab-review-heading">
            <h2 ref={reviewHeading} tabIndex={-1} id="agent-lab-review-heading" className="m-0 text-body font-semibold">
              2. Review {plan.provider === "codex" ? "Codex" : "Claude"}’s plan
            </h2>
            <p className="m-0">{plan.summary}</p>
            <ol className="m-0 grid gap-1 pl-5">
              {plan.steps.map((step, index) => <li key={index}>{step}</li>)}
            </ol>
            <pre className="m-0 max-w-full overflow-auto rounded-md border border-rule bg-paper p-3 font-mono text-caption"
              tabIndex={0} aria-label="Proposed source diff">{plan.diff}</pre>
            <p className="m-0 text-caption text-graphite">
              {expired ? "This plan expired. Generate a fresh plan before applying." :
                `Review expires at ${new Date(plan.expiresAt).toLocaleTimeString()}. Changed source will require a fresh plan.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="primary" disabled={locked || expired} onClick={() => void applyPlan()}>
                {busy === "applying" ? "Applying…" : "Apply reviewed change"}
              </Button>
              <Button type="button" disabled={locked} onClick={resetReview}>Discard plan</Button>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
