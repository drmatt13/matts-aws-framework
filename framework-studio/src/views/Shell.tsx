import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, ClipboardCheck, Redo2, Undo2, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CommandResult } from "../../shared/api";
import type { Diagnostic } from "../../shared/model";
import { api, ApiError } from "../api";
import { useStudio } from "../studio";
import { EditDialog } from "./EditDialog";
import { Inspector } from "./Inspector";
import { UnsavedChangesDialog } from "./DraftControls";

function Verdict(props: { readonly label: string; readonly diagnostics: readonly Diagnostic[] }) {
  const errors = props.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = props.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  return (
    <span className={`verdict ${errors ? "bad" : warnings ? "warning" : "good"}`}>
      {errors || warnings ? <AlertTriangle size={14} aria-hidden /> : <Check size={14} aria-hidden />}
      {props.label}
      {errors || warnings ? ` ${errors || warnings}` : ""}
    </span>
  );
}

function Drawer(props: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) {
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return (
    <aside className="drawer" aria-labelledby={id} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
    }}>
      <header>
        <h2 id={id}>{props.title}</h2>
        <button ref={close} className="icon-button" onClick={props.onClose} aria-label={`Close ${props.title}`}>
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="content">{props.children}</div>
    </aside>
  );
}

function DiagnosticsDrawer(props: { readonly onClose: () => void; readonly onCheck: () => void }) {
  const { snapshot, select, live } = useStudio();
  const all = (["dev", "prod"] as const).flatMap((mode) =>
    snapshot.models[mode].diagnostics.map((diagnostic) => ({ mode, diagnostic })),
  );
  return (
    <Drawer title="Configuration health" onClose={props.onClose}>
      <p className="small muted">Configuration validation updates automatically for Development and Production as saved source changes. Inspector changes are validated before applying.</p>
      {all.length === 0 && snapshot.source.problems.length === 0 ? (
        <p>Both graphs load and pass configuration validation.</p>
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
      <details>
        <summary>Additional checks</summary>
        <p className="small muted">Audit generated files and local wiring with framework:check. This separate check runs on saved source and writes nothing.</p>
        <button className="quiet" disabled={live.running !== null || live.evaluating} onClick={props.onCheck}>
          <ClipboardCheck size={16} aria-hidden /> Check generated files and wiring
        </button>
      </details>
    </Drawer>
  );
}

function CommandDrawer(props: { readonly result: CommandResult | undefined; readonly onClose: () => void; readonly onBack: () => void; readonly onRun: (name: string, confirmed: boolean) => void }) {
  const studio = useStudio();
  const { live } = studio;
  const result = props.result;
  const stale = result && result.exitCode !== 0 && /generat|stale|out of date|differs/i.test(result.output);
  return (
    <Drawer title={result ? `${result.command} ${result.exitCode === 0 ? "passed" : "failed"}` : `Running ${live.running ?? "a command"}…`} onClose={props.onClose}>
      <button className="linkish small" onClick={props.onBack}>Back to configuration health</button>
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

export function Shell(props: { readonly children: ReactNode; readonly notice?: ReactNode }) {
  const studio = useStudio();
  const { snapshot, response, mode, setMode, live, toast, toasts, selected } = studio;
  const [drawer, setDrawer] = useState<"health" | "command" | undefined>();
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
    <div className={`shell ${props.notice ? "has-notice" : ""}`}>
      <header className="bar">
        <span className="wordmark">
          AWS Studio<small>{repository}</small>
        </span>
        <nav className="tabs" aria-label="Views">
          <Link to="/" search={(previous: { select?: string }) => previous} className="tab" activeOptions={{ exact: true, includeSearch: false }}>
            Board
          </Link>
          <Link to="/isometric" search={(previous: { select?: string }) => previous} className="tab" activeOptions={{ includeSearch: false }}>
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
        <div className="bar-actions">
          <button className="health" onClick={() => setDrawer(drawer === "health" ? undefined : "health")} title="Configuration health · updates automatically" aria-label="Configuration health" aria-expanded={drawer === "health"}>
            {live.evaluating ? <span className="evaluating">Validating…</span> : <>
              <Verdict label="Dev" diagnostics={snapshot.models.dev.diagnostics} />
              <Verdict label="Prod" diagnostics={snapshot.models.prod.diagnostics} />
              {snapshot.source.problems.length ? <span className="verdict warning"><AlertTriangle size={14} aria-hidden />{snapshot.source.problems.length}</span> : null}
            </>}
          </button>
          <span className="history-actions" role="group" aria-label="Edit history">
            <button className="icon-button" aria-label="Undo" onClick={() => void history("undo")} disabled={!response.history.undo || studio.draft.dirty || !!studio.draftState.busy} title={response.history.undo ? `Undo ${response.history.undo}` : "Nothing to undo"}>
              <Undo2 size={16} aria-hidden />
            </button>
            <button className="icon-button" aria-label="Redo" onClick={() => void history("redo")} disabled={!response.history.redo || studio.draft.dirty || !!studio.draftState.busy} title={response.history.redo ? `Redo ${response.history.redo}` : "Nothing to redo"}>
              <Redo2 size={16} aria-hidden />
            </button>
          </span>
        </div>
      </header>
      {props.notice ? <div className="shell-notice">{props.notice}</div> : null}
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
      {drawer === "health" ? <DiagnosticsDrawer onClose={() => setDrawer(undefined)} onCheck={() => void run("framework:check", false)} /> : null}
      {drawer === "command" ? <CommandDrawer result={result} onClose={() => setDrawer(undefined)} onBack={() => setDrawer("health")} onRun={(name, confirmed) => void run(name, confirmed)} /> : null}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.tone === "refuse" ? "refuse" : ""}`}>
            {item.text}
          </div>
        ))}
      </div>
    </div>
  );
}
