import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { cx } from "../ui/classes";
import { Link, useLocation } from "@tanstack/react-router";
import { ClipboardCheck, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CommandResult } from "../../shared/api";
import type { Mode } from "../../shared/model";
import { api } from "../api";
import { ApiError } from "../http";
import { useStudio } from "../studio";
import { EditDialog } from "./EditDialog";
import { Inspector } from "./Inspector";
import { UnsavedChangesDialog } from "./DraftControls";
import { SourceRecoveryPanel } from "./SourceRecovery";
import { navigationItemClasses, NavigationStrip } from "./NavigationStrip";
import { SourceEnvironment } from "./SourceContext";

function Drawer(props: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) {
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return (
    <aside data-ui="drawer" className="fixed right-4 top-[calc(var(--bar)+12px)] z-20 flex max-h-[calc(100vh-var(--bar)-32px)] w-[min(620px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-rule-strong bg-sheet text-body leading-[1.5] shadow-[0_18px_50px_-24px_color-mix(in_srgb,var(--ink)_60%,transparent)] vp-700:top-3 vp-700:max-h-[calc(100dvh-24px)] [&_summary]:min-h-6 coarse:[&_button]:min-h-11 coarse:[&_summary]:min-h-11 [&_:is(h2,h3,h4,h5)]:text-balance" aria-labelledby={id} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
    }}>
      <header className="flex flex-none items-center justify-between border-b border-rule px-5 py-3">
        <h2 id={id} className="m-0 font-sans text-[16px]">{props.title}</h2>
        <button ref={close} className={iconButtonClasses()} onClick={props.onClose} aria-label={`Close ${props.title}`}>
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 gap-4 overflow-auto overscroll-contain p-5 [&_pre]:m-0 [&_pre]:font-mono [&_pre]:text-[0.78rem] [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere">{props.children}</div>
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
      <p className="text-caption text-graphite">Source validation checks the saved declarations in each framework mode. It does not establish AWS credentials, deployment status or application health. Inspector changes are validated before applying.</p>
      {all.length === 0 && snapshot.source.problems.length === 0 ? (
        <p>All source graphs load and pass configuration validation.</p>
      ) : null}
      {all.map(({ mode, diagnostic }, position) => (
        <div key={position} className={cx("border-l-[3px] py-0.5 pl-[10px]", diagnostic.severity === "warning" ? "border-local" : "border-refuse")}>
          <p className="text-caption text-graphite">
            {mode === "dev" ? "Development graph" : "Production graph"}, {diagnostic.stage === "load" ? "loading" : diagnostic.stage === "cloud-edges" ? "cloud edges" : "validation"}
          </p>
          <p>{diagnostic.message}</p>
          {diagnostic.entity ? (
            <button className={buttonClasses({ variant: "link", className: "text-caption" })} onClick={() => select(diagnostic.entity)}>
              Show {diagnostic.entity}
            </button>
          ) : null}
        </div>
      ))}
      {snapshot.source.problems.map((problem) => (
        <div key={problem} className="border-l-[3px] border-local py-0.5 pl-[10px]">
          <p className="text-caption text-graphite">Source index</p>
          <p>{problem}</p>
        </div>
      ))}
      <details>
        <summary>Additional checks</summary>
        <p className="text-caption text-graphite">Audit generated files and local wiring with framework:check. This separate check runs on saved source and writes nothing.</p>
        <button className={buttonClasses({ variant: "quiet" })} disabled={live.running !== null || live.evaluating} onClick={props.onCheck}>
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
      <button className={buttonClasses({ variant: "link", className: "text-caption" })} onClick={props.onBack}>Back to configuration health</button>
      {result ? (
        <>
          <p className="text-caption text-graphite">Finished in {(result.durationMs / 1000).toFixed(1)}s with exit code {String(result.exitCode)}.</p>
          {stale ? (
            <p>
              Generated files no longer match the config.{" "}
              <button className={buttonClasses({ variant: "quiet" })} onClick={() => props.onRun("framework:generate", true)} disabled={live.running !== null || studio.draft.dirty || !!studio.draftState.busy}>
                Run framework:generate
              </button>{" "}
              <span className="text-caption text-graphite">It rewrites the generated files only.</span>
            </p>
          ) : null}
          <pre>{result.output}</pre>
        </>
      ) : (
        <p className="text-graphite">The output appears here when it finishes.</p>
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
    <div data-ui="shell" className={cx("grid h-full vp-760:[--bar:89px] vp-560:[--bar:129px]", props.notice || watchProblem ? "grid-rows-[var(--bar)_auto_minmax(0,1fr)]" : "grid-rows-[var(--bar)_minmax(0,1fr)]")}>
      <header data-ui="bar" className="grid min-h-(--bar) min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-b border-rule bg-sheet px-4 vp-1200:gap-3 vp-760:grid-cols-[minmax(0,1fr)_auto] vp-760:gap-2 vp-760:py-2">
        <span className="font-condensed text-step1 font-semibold tracking-[0.01em] whitespace-nowrap vp-760:col-start-1 vp-760:row-start-1">
          AWS Studio<small className="ml-2 inline-block max-w-[180px] overflow-hidden align-middle font-sans text-step-minus1 font-normal text-graphite text-ellipsis vp-1200:hidden" title={repository}>{repository}</small>
        </span>
        <NavigationStrip className="vp-760:col-span-full vp-760:row-start-2 vp-560:row-start-3" label="Views" activeKey={pathname}>
          <Link to="/" search={(previous: { select?: string }) => previous} className={navigationItemClasses} activeOptions={{ exact: true, includeSearch: false }}>
            Map
          </Link>
          <Link to="/database" search={{}} className={navigationItemClasses} activeOptions={{ includeSearch: false }}>
            Database
          </Link>
          <Link to="/deploy" search={{}} className={navigationItemClasses} activeOptions={{ includeSearch: false }}>
            Deploy
          </Link>
          <Link to="/graphql" search={{}} className={navigationItemClasses} activeOptions={{ includeSearch: false }}>GraphQL</Link>
          <Link to="/cognito" search={{}} className={navigationItemClasses} activeOptions={{ includeSearch: false }}>Cognito</Link>
          <Link to="/domains" search={{}} className={navigationItemClasses} activeOptions={{ includeSearch: false }}>Domains</Link>
          <Link to="/websockets" search={{}} className={navigationItemClasses} activeOptions={{ includeSearch: false }}>WebSockets</Link>
        </NavigationStrip>
        <div className="flex items-center gap-3 vp-760:col-start-2 vp-760:row-start-1 vp-560:contents">
          <SourceEnvironment />
        </div>
      </header>
      {props.notice || watchProblem ? <div data-ui="shell-notice" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-refuse bg-refuse-wash px-4 py-2 text-label [&>span]:flex-[1_1_240px] [&>button]:flex-none">{props.notice}{watchProblem ? <>
        <span role="status">{sourceWatch.status === "polling" ? `Source watching is interrupted. Checking for changes every ${sourceWatch.pollIntervalMs / 1000}s.` : "Source freshness is unknown. Some files could not be read."} <details><summary>Source observation details</summary><ul>{sourceWatch.problems.map((problem, at) => <li key={at}>{problem.path}: {problem.code}</li>)}</ul></details></span>
        <button className={buttonClasses({ variant: "quiet" })} disabled={refreshing || live.evaluating} onClick={() => void refreshSource()}>{refreshing ? "Reloading source…" : "Reload source"}</button>
      </> : null}</div> : null}
      <div data-studio-workspace data-ui="workspace" className={cx("grid min-h-0 vp-900:grid-cols-1", showInspector ? "grid-cols-[minmax(0,1fr)_var(--inspector)] vp-900:grid-rows-[minmax(120px,1fr)_minmax(0,2fr)] has-[>[data-ui=source-watch-warning]]:grid-rows-[auto_minmax(0,1fr)] vp-900:has-[>[data-ui=source-watch-warning]]:grid-rows-[auto_minmax(180px,1fr)_auto]" : "grid-cols-1 vp-900:grid-rows-[minmax(0,1fr)] has-[>[data-ui=source-watch-warning]]:grid-rows-[auto_minmax(0,1fr)]")}>
        <SourceRecoveryPanel initial={response.sourceRecovery} problem={response.sourceRecoveryProblem} />
        <main data-ui="canvas" data-stale={studio.model.stale || undefined} className="relative min-h-0 overflow-auto data-[stale=true]:[&_[data-ui=board]]:opacity-55 data-[stale=true]:[&_[data-ui=board]]:grayscale-[0.6]">
          {studio.model.stale ? (
            <p className="sticky top-0 z-5 m-0 border-b border-[color-mix(in_srgb,var(--refuse)_35%,transparent)] bg-refuse-wash px-6 py-[10px]" role="status">
              The configuration does not load right now, so this is the last version that did. Editing is paused.{" "}
              <button className={buttonClasses({ variant: "link" })} onClick={() => setDrawer("health")}>
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
      <div className="fixed bottom-4 left-4 z-30 grid max-w-[min(460px,calc(100vw-32px))] gap-2" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={cx("rounded-md px-4 py-3 text-step-minus1 text-sheet shadow-popover wrap-anywhere", item.tone === "refuse" ? "bg-refuse" : "bg-ink")}>
            {item.text}
          </div>
        ))}
      </div>
    </div>
  );
}
