import { Link, useLocation } from "@tanstack/react-router";
import { AlertTriangle, Check, ClipboardCheck, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CommandResult } from "../../shared/api";
import type { Mode } from "../../shared/model";
import { api, ApiError } from "../api";
import { useStudio } from "../studio";
import { EditDialog } from "./EditDialog";
import { Inspector } from "./Inspector";
import { UnsavedChangesDialog } from "./DraftControls";
import { SourceRecoveryPanel } from "./SourceRecovery";
import { NavigationStrip } from "./NavigationStrip";

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
  const all = (Object.keys(snapshot.models) as Mode[]).flatMap((mode) =>
    snapshot.models[mode].diagnostics.map((diagnostic) => ({ mode, diagnostic })),
  );
  return (
    <Drawer title="Configuration health" onClose={props.onClose}>
      <p className="small muted">Source validation checks the saved declarations in each framework mode. It does not establish AWS credentials, deployment status or application health. Inspector changes are validated before applying.</p>
      {all.length === 0 && snapshot.source.problems.length === 0 ? (
        <p>All source graphs load and pass configuration validation.</p>
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
  const { snapshot, response, live, toast, toasts, selected } = studio;
  const pathname = useLocation({ select: location => location.pathname });
  const databasePage = useLocation({ select: location => location.pathname === "/database" });
  // Isometric hosts the inspector in its own side panel, below the map toolbar.
  const isometricPage = useLocation({ select: location => location.pathname === "/" });
  const sourceWatch = live.sourceWatch ?? response.sourceWatch;
  const watchProblem = sourceWatch && sourceWatch.status !== "watching";
  const [refreshing, setRefreshing] = useState(false);
  const refreshSource = async () => {
    setRefreshing(true);
    try { await api.refreshSource(); toast("Source reloaded. Any draft is preserved for review."); }
    catch (error) { toast(error instanceof Error ? error.message : String(error), "refuse"); }
    finally { setRefreshing(false); }
  };
  const showInspector = !!selected && !isometricPage && !(databasePage && selected.startsWith("schema:"));
  const [drawer, setDrawer] = useState<"health" | "command" | undefined>();
  const [result, setResult] = useState<CommandResult | undefined>();
  const healthDescriptionId = useId();
  const modes = Object.keys(snapshot.models) as Mode[];
  const diagnostics = modes.flatMap(candidate => snapshot.models[candidate].diagnostics);
  const errorCount = diagnostics.filter(item => item.severity === "error").length;
  const warningCount = diagnostics.filter(item => item.severity === "warning").length + snapshot.source.problems.length;
  const healthLabel = live.evaluating ? "Checking source…" : errorCount ? `Source: ${errorCount} ${errorCount === 1 ? "error" : "errors"}` : warningCount ? `Source: ${warningCount} ${warningCount === 1 ? "warning" : "warnings"}` : "Source valid";
  const healthDescription = live.evaluating ? "Validating configuration" : modes.map(candidate => {
    const diagnostics = snapshot.models[candidate].diagnostics;
    const errors = diagnostics.filter(item => item.severity === "error").length;
    const warnings = diagnostics.filter(item => item.severity === "warning").length;
    return `${candidate === "dev" ? "Development" : "Production"}: ${errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : "valid"}${warnings ? `, ${warnings} ${warnings === 1 ? "warning" : "warnings"}` : ""}`;
  }).join(". ") + (snapshot.source.problems.length ? `. ${snapshot.source.problems.length} source problems` : "");
  const repository = snapshot.repositoryRoot.replaceAll("\\", "/").split("/").pop();

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
    <div className={`shell ${props.notice || watchProblem ? "has-notice" : ""}`}>
      <header className="bar">
        <span className="wordmark">
          AWS Studio<small title={repository}>{repository}</small>
        </span>
        <NavigationStrip className="tabs" label="Views" activeKey={pathname}>
          <Link to="/" search={(previous: { select?: string }) => previous} className="tab" activeOptions={{ exact: true, includeSearch: false }}>
            Map
          </Link>
          <Link to="/database" search={{}} className="tab" activeOptions={{ includeSearch: false }}>
            Database
          </Link>
          <Link to="/deploy" search={{}} className="tab" activeOptions={{ includeSearch: false }}>
            Deploy
          </Link>
          <Link to="/cognito" search={{}} className="tab" activeOptions={{ includeSearch: false }}>Cognito</Link>
          <Link to="/domains" search={{}} className="tab" activeOptions={{ includeSearch: false }}>Domains</Link>
          <Link to="/websockets" search={{}} className="tab" activeOptions={{ includeSearch: false }}>WebSockets</Link>
        </NavigationStrip>
        <div className="bar-actions">
          <button className={`health ${live.evaluating ? "evaluating" : errorCount ? "bad" : warningCount ? "warning" : "good"}`} onClick={() => setDrawer(drawer === "health" ? undefined : "health")} title="Source validation · deployment and runtime health are inspected separately" aria-label={`${healthLabel}. Configuration health`} aria-describedby={healthDescriptionId} aria-expanded={drawer === "health"}>
            {live.evaluating ? <LoaderCircle size={14} aria-hidden /> : errorCount || warningCount ? <AlertTriangle size={14} aria-hidden /> : <Check size={14} aria-hidden />}<span>{healthLabel}</span>
          </button>
        </div>
        <span id={healthDescriptionId} className="sr-only">{healthDescription}</span>
      </header>
      {props.notice || watchProblem ? <div className="shell-notice">{props.notice}{watchProblem ? <>
        <span role="status">{sourceWatch.status === "polling" ? `Source watching is interrupted. Checking for changes every ${sourceWatch.pollIntervalMs / 1000}s.` : "Source freshness is unknown. Some files could not be read."} <details><summary>Source observation details</summary><ul>{sourceWatch.problems.map((problem, at) => <li key={at}>{problem.path}: {problem.code}</li>)}</ul></details></span>
        <button className="quiet" disabled={refreshing || live.evaluating} onClick={() => void refreshSource()}>{refreshing ? "Reloading source…" : "Reload source"}</button>
      </> : null}</div> : null}
      <div className={`workspace ${showInspector ? "" : "no-selection"}`}>
        <SourceRecoveryPanel initial={response.sourceRecovery} problem={response.sourceRecoveryProblem} />
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
        {showInspector ? <Inspector /> : null}
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
