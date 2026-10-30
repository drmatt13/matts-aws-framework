import { useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { identityPolicyStatements,type IdentityPolicySimulation,type IdentityPolicySource,type IdentityPolicyStatement } from "../../shared/identity-policy";
import { call } from "../http";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { Select,Textarea,TextInput } from "../ui/FormControls";
import { noticeClasses } from "../ui/Surface";
import { cx } from "../ui/classes";
import { DocumentCard,documentDataTableClasses,documentFieldsetClasses,documentLabelClasses,documentTableRegionClasses,documentToolbarClasses } from "./DocumentUI";
import { WorkbenchDialog } from "./WorkbenchUI";

export function IdentityPolicyEditor({ profile, region, account: selectedAccount, contextKey = "", contextLabel = "selected context", active = true }: { profile: string; region: string; account?: string; contextKey?: string; contextLabel?: string; active?: boolean }) {
  const { snapshot, model, live, draft, draftState } = useStudio();
  const query = useQuery({ queryKey: ["identity-policy", snapshot.revision], queryFn: async () => {
    const result = await call<{ revision: string; sources: IdentityPolicySource[] }>("/identity-policy/sources");
    if (!Array.isArray(result?.sources)) throw new Error("Identity policy editing is unavailable in the running server. Restart npm run studio.");
    return result;
  } });
  const [target, setTarget] = useState(""); const [statements, setStatements] = useState<readonly IdentityPolicyStatement[]>([]);
  const [allowUnauthenticated, setAllowUnauthenticated] = useState(false);
  const [account, setAccount] = useState(selectedAccount ?? ""); const [role, setRole] = useState<"reader" | "default">("reader");
  const [actions, setActions] = useState("s3:GetObject\ns3:PutObject"); const [resources, setResources] = useState("");
  const [result, setResult] = useState<IdentityPolicySimulation>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState<{ key: string; label: string }>();
  const [sourceChanged, setSourceChanged] = useState(false);
  const baseline = useRef<string | undefined>(undefined);
  const localValues = JSON.stringify({ statements, allowUnauthenticated });
  const localNow = useRef(localValues); localNow.current = localValues;
  const simulationRequest = useRef(0);
  const source = query.data?.sources.find(source => source.target === target);
  useEffect(() => {
    if (query.data && !query.data.sources.some(source => source.target === target)) {
      if (baseline.current && localNow.current !== baseline.current) setSourceChanged(true);
      else { baseline.current = undefined; setTarget(query.data.sources[0]?.target ?? ""); }
    }
  }, [query.data, target]);
  const loadSource = () => {
    setResult(undefined); setError("");
    if (!source) {
      baseline.current = undefined;
      setStatements([]); setAllowUnauthenticated(false); setResources("");
      setSourceChanged(false); setOrigin(undefined);
      setTarget(query.data?.sources[0]?.target ?? "");
      return;
    }
    baseline.current = JSON.stringify({ statements: source.statements, allowUnauthenticated: source.allowUnauthenticated });
    setStatements(source.statements); setAllowUnauthenticated(source.allowUnauthenticated); setSourceChanged(false); setOrigin(undefined);
    setResources(source.statements[0]?.Resource[0]?.replace(/\*$/, "example.json") ?? "");
  };
  useEffect(() => {
    if (!source) return;
    const saved = JSON.stringify({ statements: source.statements, allowUnauthenticated: source.allowUnauthenticated });
    if (!baseline.current || localNow.current === baseline.current || localNow.current === saved) loadSource();
    else if (saved !== baseline.current) setSourceChanged(true);
    setResult(undefined);
  }, [source]);
  useEffect(() => { setAccount(selectedAccount ?? ""); }, [selectedAccount, contextKey]);
  useEffect(() => { simulationRequest.current++; setResult(undefined); setBusy(false); }, [contextKey, profile, region, account, role, actions, resources, target, snapshot.revision, active]);
  useEffect(() => () => { simulationRequest.current++; }, []);
  const changed = JSON.stringify(statements) !== JSON.stringify(source?.statements ?? []) || allowUnauthenticated !== (source?.allowUnauthenticated ?? false);
  const contextChanged = changed && !!origin && origin.key !== contextKey;
  const paused = !!draftState.busy || draft.dirty || draft.conflict || model.stale || live.evaluating || sourceChanged || contextChanged;
  const departure = useBlocker({ withResolver: true, enableBeforeUnload: false, shouldBlockFn: ({ next }) => changed && !draft.dirty && !(next.pathname === "/cognito" || next.pathname.startsWith("/cognito/")) });
  const editing = () => setOrigin(current => current ?? { key: contextKey, label: contextLabel });
  useEffect(() => {
    if (!changed) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect); return () => window.removeEventListener("beforeunload", protect);
  }, [changed]);
  const update = (index: number, patch: Partial<IdentityPolicyStatement>) => { editing(); setStatements(statements.map((statement, at) => at === index ? { ...statement, ...patch } : statement)); };
  const stage = () => {
    if (paused) return;
    setError(""); try { const validated = identityPolicyStatements(statements); draft.stageOperation({ kind: "identityPolicy", target, statements: validated, allowUnauthenticated }); void draft.review(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const simulate = async () => {
    const generation = ++simulationRequest.current;
    setBusy(true); setError(""); setResult(undefined);
    try { const next = await call<IdentityPolicySimulation>("/identity-policy/simulate", { target, revision: query.data!.revision, profile, account, region, role, actions: actions.split("\n").map(value => value.trim()).filter(Boolean), resources: resources.split("\n").map(value => value.trim()).filter(Boolean) }); if (generation === simulationRequest.current) setResult(next); }
    catch (reason) { if (generation === simulationRequest.current) setError(reason instanceof Error ? reason.message : String(reason)); } finally { if (generation === simulationRequest.current) setBusy(false); }
  };
  return <DocumentCard className={"mb-3"}><h2 className={"mt-0 mb-2 text-[15px] leading-[1.4]"}>Reader role policies and permission simulation</h2>
    <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>Edit the recognized generated stack's native helper options. The default authenticated role stays permissionless, pool trust and group-role mapping stay fixed, and source approval does not deploy IAM changes.</p>
    {query.error ? <p className={cx(noticeClasses(), "mt-0 mb-2 text-label leading-[1.5] last:mb-0")} role="alert">{query.error.message}</p> : null}
    {contextChanged ? <p className={cx(noticeClasses(), "mt-0 mb-2 text-label leading-[1.5] last:mb-0")} role="alert">Unsaved policy edits belong to {origin?.label}. Return to that context to review, or discard these local edits. No proposal was transferred to this target.</p> : null}
    {sourceChanged ? <p className={cx(noticeClasses(), "mt-0 mb-2 text-label leading-[1.5] last:mb-0")} role="alert">Saved policy source changed while local edits were open. Local edits are retained; reload saved policy before a new review.</p> : null}
    {changed ? <button className={buttonClasses({ variant: "quiet" })} disabled={!!draftState.busy || draft.dirty} onClick={loadSource}>Discard local policy edits</button> : null}
    {!query.data?.sources.length ? <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>No editable generated identity-pool stack was found. Create identity pool source in Identity Pools, or review custom role source in your editor.</p> : <>
      <label className={documentLabelClasses}>Policy stack<Select className={"w-full"} aria-label="Identity policy stack" disabled={!!draftState.busy || draft.dirty || changed} value={target} onChange={event => { baseline.current = undefined; setTarget(event.target.value); }}>{query.data.sources.map(source => <option key={source.target} value={source.target}>{source.target}</option>)}</Select></label>
      {source ? <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-caption"}>Source authority: <code>{source.file}</code>. Unrecognized custom shapes refuse edits; no separate policy config is created.</p> : null}
      {source?.problem ? <p className={cx(noticeClasses(), "mt-0 mb-2 text-label leading-[1.5] last:mb-0")} role="alert">{source.problem}</p> : <>
        <label className={documentLabelClasses}><TextInput type="checkbox" aria-label="Enable permissionless guest identities" checked={allowUnauthenticated} disabled={paused} onChange={event => { editing(); setAllowUnauthenticated(event.target.checked); }} /> Enable unauthenticated guest identities (explicit opt-in, no AWS API grants)</label><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite"}>Guests can obtain a separate pool-constrained unauthenticated identity role after deployment. That role is permissionless; ReaderRole statements never grant guest access. Classic auth stays disabled.</p>
        {!statements.length ? <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>No ReaderRole AWS API grants are declared.</p> : null}
        {statements.map((statement, index) => <fieldset className={documentFieldsetClasses} key={index} disabled={paused}><legend className={"px-1 text-label"}>Statement {index + 1}</legend><div className={documentToolbarClasses}>
          <label className={documentLabelClasses}>Effect<Select className={"w-full"} aria-label={`Policy effect ${index + 1}`} value={statement.Effect} onChange={event => update(index, { Effect: event.target.value as "Allow" | "Deny" })}><option>Allow</option><option>Deny</option></Select></label>
          <label className={documentLabelClasses}>Actions (one per line)<Textarea className={"w-full min-h-20"} aria-label={`Policy actions ${index + 1}`} value={statement.Action.join("\n")} onChange={event => update(index, { Action: event.target.value.split("\n").map(value => value.trim()).filter(Boolean) })} /></label>
          <label className={documentLabelClasses}>Resource ARNs (one per line)<Textarea className={"w-full min-h-20"} aria-label={`Policy resources ${index + 1}`} value={statement.Resource.join("\n")} onChange={event => update(index, { Resource: event.target.value.split("\n").map(value => value.trim()).filter(Boolean) })} /></label>
          <button className={buttonClasses({ variant: "quiet" })} onClick={() => { editing(); setStatements(statements.filter((_, at) => at !== index)); }}>Remove statement {index + 1}</button>
        </div></fieldset>)}
        <div className={documentToolbarClasses}><button className={buttonClasses({ variant: "quiet" })} disabled={paused} onClick={() => { editing(); setStatements([...statements, { Effect: "Allow", Action: ["s3:GetObject"], Resource: [] }]); }}>Add scoped Allow statement</button><button className={buttonClasses({ variant: "quiet" })} disabled={paused} onClick={() => { editing(); setStatements([...statements, { Effect: "Deny", Action: ["s3:PutObject"], Resource: [] }]); }}>Add explicit Deny statement</button><button className={buttonClasses({ variant: "primary" })} disabled={!changed || paused} onClick={stage}>Review reader policy source</button></div>
        <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite"}>Allow supports concrete data operations only. Wildcard/admin/secret/credential grants, custom conditions/principals and unbounded resources require deliberate native source review. Explicit Deny wins over an Allow in the simulated document.</p>
        <details className={"mt-3"}><summary className={"cursor-pointer py-1 text-label [[open]>&]:mb-2"}>Simulate saved policy (read-only AWS IAM)</summary><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>Uses profile <strong>{profile}</strong> in {region}. Verify the expected account below. These are the saved source statements, not deployed role policies.</p>
          <div className={documentToolbarClasses}><label className={documentLabelClasses}>Expected simulation account<TextInput className={"w-full"} aria-label="Expected simulation account" value={account} onChange={event => setAccount(event.target.value)} /></label><label className={documentLabelClasses}>Role context<Select className={"w-full"} aria-label="Simulation role context" value={role} onChange={event => setRole(event.target.value as "reader" | "default")}><option value="reader">Reader-group role (claim selection unverified)</option><option value="default">Default role / missing reader group (no grants)</option></Select></label><label className={documentLabelClasses}>Action context (one per line)<Textarea className={"w-full min-h-20"} aria-label="Simulation actions" value={actions} onChange={event => setActions(event.target.value)} /></label><label className={documentLabelClasses}>Resource context (one per line)<Textarea className={"w-full min-h-20"} aria-label="Simulation resources" value={resources} onChange={event => setResources(event.target.value)} /></label></div>
          <button className={buttonClasses({ variant: "quiet" })} disabled={busy || changed || paused || !/^\d{12}$/.test(account) || !resources.trim()} onClick={() => void simulate()}>{busy ? "Simulating…" : "Simulate saved policy"}</button>
          {changed || draft.dirty ? <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>Apply or discard source changes before simulating the saved policy.</p> : null}
          <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>Missing or conflicting group claims can prevent role selection before IAM evaluation. This action does not sign in, issue credentials, mutate IAM, call the target resource or infer application RBAC.</p>
          {result ? <div role="status"><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>{result.engine} · {result.account} · {result.profile} · {result.observedAt}</p><div className={documentTableRegionClasses} role="region" aria-label="IAM simulation results" tabIndex={0}><table className={documentDataTableClasses}><colgroup><col className={"w-[120px]"} /><col /><col className={"w-[120px]"} /><col className={"w-[160px]"} /></colgroup><thead><tr><th className={"border-b border-rule p-2 text-left align-top text-caption"}>Action</th><th className={"border-b border-rule p-2 text-left align-top text-caption"}>Resource</th><th className={"border-b border-rule p-2 text-left align-top text-caption"}>Decision</th><th className={"border-b border-rule p-2 text-left align-top text-caption"}>Missing context</th></tr></thead><tbody>{result.results.map((row, index) => <tr key={index}><td className={"border-b border-rule p-2 text-left align-top text-caption"}>{row.action}</td><td className={"border-b border-rule p-2 text-left align-top text-caption"}>{row.resource}</td><td className={"border-b border-rule p-2 text-left align-top text-caption"}>{row.decision}</td><td className={"border-b border-rule p-2 text-left align-top text-caption"}>{row.missingContext.join(", ") || "none returned"}</td></tr>)}</tbody></table></div>{result.limitations.map(line => <p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite"} key={line}>{line}</p>)}</div> : null}
        </details>
      </>}
    </>}
    {error ? <p className={cx(noticeClasses(), "mt-0 mb-2 text-label leading-[1.5] last:mb-0")} role="alert">{error}</p> : null}
    {departure.status === "blocked" ? createPortal(<WorkbenchDialog title="Unsaved policy edits" onClose={departure.reset} footer={<><button className={buttonClasses({ variant: "quiet" })} onClick={departure.reset}>Keep editing policy</button><button className={buttonClasses({ variant: "neutral", tone: "danger" })} onClick={() => { loadSource(); departure.proceed(); }}>Discard local policy edits and leave</button></>}><p className={"mt-0 mb-2 text-label leading-[1.5] last:mb-0"}>Your reader-policy edits have not been proposed for source review. Switching Cognito sections keeps them. Leaving this workspace discards them.</p></WorkbenchDialog>, document.body) : null}
  </DocumentCard>;
}

