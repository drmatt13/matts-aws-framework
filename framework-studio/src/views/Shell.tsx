import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, ClipboardCheck, Redo2, Undo2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CommandResult } from "../../shared/api";
import type { Diagnostic } from "../../shared/model";
import { api, ApiError } from "../api";
import { useStudio } from "../studio";
import { EditDialog } from "./EditDialog";
import { Inspector } from "./Inspector";
import { UnsavedChangesDialog } from "./DraftControls";
import { InfrastructureNavigation, InfrastructurePanel } from "./Infrastructure";

function Verdict(props: { readonly label: string; readonly diagnostics: readonly Diagnostic[] }) {
  const errors = props.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  return (
    <span className={`verdict ${errors ? "bad" : "good"}`}>
      {errors ? <AlertTriangle size={14} aria-hidden /> : <Check size={14} aria-hidden />}
      {props.label}
      {errors ? ` ${errors}` : ""}
    </span>
  );
}

function Drawer(props: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) {
  return (
    <aside className="drawer" aria-label={props.title}>
      <header>
        <h2>{props.title}</h2>
        <button className="icon-button" onClick={props.onClose} aria-label="Close">
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="content">{props.children}</div>
    </aside>
  );
}

function DiagnosticsDrawer(props: { readonly onClose: () => void }) {
  const { snapshot, select } = useStudio();
  const all = (["dev", "prod"] as const).flatMap((mode) =>
    snapshot.models[mode].diagnostics.map((diagnostic) => ({ mode, diagnostic })),
  );
  return (
    <Drawer title="Configuration health" onClose={props.onClose}>
      {all.length === 0 && snapshot.source.problems.length === 0 ? (
        <p>Both graphs load and pass the framework's checks. This view stays current as you edit in your own editor.</p>
      ) : null}
      {all.map(({ mode, diagnostic }, position) => (
        <div key={position} className={`diagnostic ${diagnostic.severity}`}>
          <p className="small muted">
            {mode === "dev" ? "Development graph" : "Production graph"}, {diagnostic.stage === "load" ? "loading" : diagnostic.stage === "cloud-edges" ? "cloud edges" : "validation"}
          </p>
          <p>{diagnostic.message}</p>
          {diagnostic.entity ? (
            <button className="linkish small" onClick={() => select(diagnostic.entity)}>
              Show {diagnostic.entity}
            </button>
          ) : null}
        </div>
      ))}
      {snapshot.source.problems.map((problem) => (
        <div key={problem} className="diagnostic warning">
          <p className="small muted">Source index</p>
          <p>{problem}</p>
        </div>
      ))}
    </Drawer>
  );
}

function CommandDrawer(props: { readonly result: CommandResult | undefined; readonly onClose: () => void; readonly onRun: (name: string, confirmed: boolean) => void }) {
  const studio = useStudio();
  const { live } = studio;
  const result = props.result;
  const stale = result && result.exitCode !== 0 && /generat|stale|out of date|differs/i.test(result.output);
  return (
    <Drawer title={result ? `${result.command} ${result.exitCode === 0 ? "passed" : "failed"}` : `Running ${live.running ?? "a command"}…`} onClose={props.onClose}>
      {result ? (
        <>
          <p className="small muted">Finished in {(result.durationMs / 1000).toFixed(1)}s with exit code {String(result.exitCode)}.</p>
          {stale ? (
            <p>
              Generated files no longer match the config.{" "}
              <button className="quiet" onClick={() => props.onRun("framework:generate", true)} disabled={live.running !== null || studio.draft.dirty || !!studio.draftState.busy}>
                Run framework:generate
              </button>{" "}
              <span className="small muted">It rewrites the generated files only.</span>
            </p>
          ) : null}
          <pre>{result.output}</pre>
        </>
      ) : (
        <p className="muted">The output appears here when it finishes.</p>
      )}
    </Drawer>
  );
}

export function Shell(props: { readonly children: ReactNode }) {
  const studio = useStudio();
  const { snapshot, response, mode, setMode, live, toast, toasts, selected } = studio;
  const [drawer, setDrawer] = useState<"health" | "command" | "infrastructure" | undefined>();
  const [infrastructureOwner, setInfrastructureOwner] = useState<string | undefined>();
  const [result, setResult] = useState<CommandResult | undefined>();
  const repository = snapshot.repositoryRoot.replaceAll("\\", "/").split("/").pop();

  const history = async (direction: "undo" | "redo") => {
    try {
      const outcome = await (direction === "undo" ? api.undo() : api.redo());
      toast(outcome.message, outcome.status === "applied" ? "plain" : "refuse");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : String(error), "refuse");
    }
  };

  const run = async (name: string, confirmed: boolean) => {
    setResult(undefined);
    setDrawer("command");
    try {
      setResult(await api.command(name, confirmed));
    } catch (error) {
      setDrawer(undefined);
      toast(error instanceof ApiError ? error.message : String(error), "refuse");
    }
  };

  return (
    <InfrastructureNavigation.Provider value={(owner) => { setInfrastructureOwner(owner); setDrawer("infrastructure"); }}><div className="shell">
      <header className="bar">
        <span className="wordmark">
          AWS Studio<small>{repository}</small>
        </span>
        <nav className="tabs" aria-label="Views">
          <Link to="/" search={(previous) => previous} className="tab" activeOptions={{ exact: true, includeSearch: false }}>
            Board
          </Link>
          <Link to="/isometric" search={(previous) => previous} className="tab" activeOptions={{ includeSearch: false }}>
            Isometric
          </Link>
          <Link to="/database" search={{}} className="tab" activeOptions={{ includeSearch: false }}>
            Database
          </Link>
          <Link to="/deploy" search={{}} className="tab" activeOptions={{ includeSearch: false }}>
            Deploy
          </Link>
        </nav>
        <span className="segmented" role="group" aria-label="Graph">
          {(["dev", "prod"] as const).map((candidate) => (
            <button
              key={candidate}
              aria-pressed={mode === candidate}
              onClick={() => setMode(candidate)}
            >
              {candidate === "dev" ? "Development" : "Production"}
            </button>
          ))}
        </span>
        <span className="spacer" />
        {live.evaluating ? <span className="evaluating">Re-evaluating…</span> : null}
        <button className="icon-button" onClick={() => { setInfrastructureOwner(undefined); setDrawer(drawer === "infrastructure" ? undefined : "infrastructure"); }}>Infrastructure</button>
        <button className="health" onClick={() => setDrawer(drawer === "health" ? undefined : "health")} title="Configuration health">
          <Verdict label="Dev" diagnostics={snapshot.models.dev.diagnostics} />
          <Verdict label="Prod" diagnostics={snapshot.models.prod.diagnostics} />
          <span className="small muted">{snapshot.models.dev.evaluatedInMs + snapshot.models.prod.evaluatedInMs} ms</span>
        </button>
        <button className="icon-button" onClick={() => void history("undo")} disabled={!response.history.undo || studio.draft.dirty || !!studio.draftState.busy} title={response.history.undo ? `Undo ${response.history.undo}` : "Nothing to undo"}>
          <Undo2 size={16} aria-hidden /> Undo
        </button>
        <button className="icon-button" onClick={() => void history("redo")} disabled={!response.history.redo || studio.draft.dirty || !!studio.draftState.busy} title={response.history.redo ? `Redo ${response.history.redo}` : "Nothing to redo"}>
          <Redo2 size={16} aria-hidden /> Redo
        </button>
        <button className="icon-button" onClick={() => void run("framework:check", false)} disabled={live.running !== null} title={response.commands["framework:check"]?.description}>
          <ClipboardCheck size={16} aria-hidden /> Check
        </button>
      </header>
      <div className={`workspace ${selected ? "" : "no-selection"}`}>
        <main className={`canvas ${studio.model.stale ? "stale" : ""}`}>
          {studio.model.stale ? (
            <p className="stale-banner" role="status">
              The configuration does not load right now, so this is the last version that did. Editing is paused.{" "}
              <button className="linkish" onClick={() => setDrawer("health")}>
                Show why
              </button>
            </p>
          ) : null}
          {props.children}
        </main>
        {selected ? <Inspector /> : null}
      </div>
      {studio.draftState.reviewOpen ? <EditDialog review={studio.draftState.review} /> : null}
      <UnsavedChangesDialog />
      {drawer === "health" ? <DiagnosticsDrawer onClose={() => setDrawer(undefined)} /> : null}
      {drawer === "command" ? <CommandDrawer result={result} onClose={() => setDrawer(undefined)} onRun={(name, confirmed) => void run(name, confirmed)} /> : null}
      {drawer === "infrastructure" ? <Drawer title="Infrastructure" onClose={() => setDrawer(undefined)}><InfrastructurePanel key={`${mode}:${infrastructureOwner ?? "all"}`} initialOwner={infrastructureOwner} onNavigate={(id) => { studio.select(id); setDrawer(undefined); }} /></Drawer> : null}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.tone === "refuse" ? "refuse" : ""}`}>
            {item.text}
          </div>
        ))}
      </div>
    </div></InfrastructureNavigation.Provider>
  );
}
