import { Link, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { CognitoObservation, IdentityPoolsObservation, IdentitySelection, IdentitySource } from "../../shared/identity";
import type { DeployOverview } from "../../shared/deploy";
import type { Mode } from "../../shared/model";
import { deployApi } from "../deploy/api";
import { identityApi, inspectionErrorMessage } from "../identity-api";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";
import { CognitoManagement } from "./CognitoManagement";
import { CreationWizard } from "./CreationWizard";
import { DataRetention } from "./DataRetention";
import { DraftFooter } from "./DraftControls";
import { IdentityPolicyEditor } from "./IdentityPolicyEditor";
import { NavigationStrip } from "./NavigationStrip";
import { SourceEnvironment, SourceHistory } from "./SourceContext";
import "./identity-workspace.css";
import "./authentication.css";

const sections = [
  { id: "user-pools", label: "User Pools", to: "/cognito/user-pools" },
  { id: "identity-pools", label: "Identity Pools", to: "/cognito/identity-pools" },
  { id: "providers", label: "Providers", to: "/cognito/providers" },
  { id: "permissions", label: "Permissions & RBAC", to: "/cognito/permissions" },
] as const;
type Section = typeof sections[number]["id"];
interface Evidence<T> { readonly data: T; readonly revision: string; readonly hash: string }
interface Inspection { readonly cognito?: Evidence<CognitoObservation>; readonly pools?: Evidence<IdentityPoolsObservation>; readonly errors?: Partial<Record<"cognito" | "pools", string>> }

export function authenticationSelection(mode: Mode, overview?: DeployOverview): IdentitySelection {
  const preferred = overview?.targets.find(target => target.name === overview.preferences?.deployment && target.mode === mode);
  const target = preferred ?? overview?.targets.find(target => target.mode === mode);
  const profile = target && overview?.preferences?.profiles[target.name] || overview?.preferences?.profile || overview?.profiles[0]?.name || "";
  return { profile, deployment: target?.name ?? "", region: target?.region ?? overview?.profiles.find(entry => entry.name === profile)?.region ?? "us-east-1" };
}

function ProviderEvidence({ source, result }: { readonly source?: IdentitySource; readonly result?: CognitoObservation }) {
  const { snapshot } = useStudio();
  const declared = source?.declaredProviders ?? [];
  const rows = [
    { name: "Google", type: "Google", declaration: source ? source.google.clientIdPresent ? "Client ID input present" : "Client ID input absent" : "Unknown", secret: source?.google.authoredSecretPresent ? "Authored input present; access unverified" : "Presence / access unverified" },
    ...declared.map(provider => ({ name: provider.name, type: provider.type.toUpperCase(), declaration: `${provider.scope === "both" || provider.scope === source?.mode ? "Declared for this environment" : "Declared for another environment"} · ${provider.scope}`, secret: provider.type === "oidc" ? "Reference declared; access unverified" : "Not required by SAML" })),
    ...(result?.providers ?? []).filter(provider => provider.name !== "Google" && !declared.some(entry => entry.name === provider.name)).map(provider => ({ name: provider.name, type: provider.type, declaration: "Not matched to a source declaration", secret: "Presence / access unverified" })),
  ];
  return <section className="identity-card"><h2>Federation providers</h2><p className="muted">Studio supports Google, OIDC and SAML. Source, AWS metadata and a working sign-in are separate checks.</p>
    {source ? <div className="auth-source-action"><a className="button quiet" href={editorLink(snapshot.repositoryRoot, { file: source.file, line: 1, column: 1, start: 0, end: 0 })}>Open Google inputs in editor</a><p className="small muted"><code>{source.file}</code> · <code>GOOGLE_CLIENT_ID</code>: {source.google.clientIdPresent ? "present" : "absent"}; <code>GOOGLE_CLIENT_SECRET</code>: {source.google.authoredSecretPresent ? "present" : "absent"}. Values stay in your editor.</p></div> : null}
    <div className="auth-table" tabIndex={0} role="region" aria-label="Provider verification evidence"><table><thead><tr><th>Provider</th><th>Source intent</th><th>Deployed metadata</th><th>Secret</th><th>Provider application</th><th>Sign-in</th></tr></thead><tbody>{rows.map(row => <tr key={row.name}><th scope="row">{row.name}<small>{row.type} · {/^(Google|OIDC|SAML)$/i.test(row.type) ? "supported" : "native provider; source authoring unavailable"}</small></th><td>{row.declaration}</td><td>{result ? result.providers.some(provider => provider.name === row.name) ? "Observed in selected pool" : "Not returned by inspection" : "Unverified"}</td><td>{row.secret}</td><td>Unverified</td><td>Unverified</td></tr>)}</tbody></table></div>
    {result?.providers.map(provider => <details key={provider.name}><summary>{provider.name} · observed configuration</summary><dl className="auth-metadata">{Object.entries(provider.settings).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><p>Mapped attributes: {provider.mappedAttributes.join(", ") || "none returned"}</p></details>)}
    <details><summary>Provider setup and verification</summary><p>For Google, review the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">OAuth client settings</a>, consent/test-user policy and <code>https://&lt;cognito-domain&gt;/oauth2/idpresponse</code> redirect. Start sign-in from the application to preserve PKCE/state.</p><p>For <a href="https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html" target="_blank" rel="noreferrer">OIDC</a>, verify issuer, discovery, scopes, redirect and verified-email claims. For <a href="https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html" target="_blank" rel="noreferrer">SAML</a>, verify metadata, SP entity ID and ACS. The application callback is distinct from the provider callback.</p><p>Secret values are never requested here. Authored presence does not establish a deployed value, accessible secret or accepted provider credentials.</p></details>
  </section>;
}

function Groups({ result }: { readonly result?: CognitoObservation }) {
  return <section className="identity-card"><h2>Groups and role claims</h2>{result ? <><div className="auth-table"><table><thead><tr><th>Group</th><th>Precedence</th><th>IAM role claim</th></tr></thead><tbody>{result.groups.map(group => <tr key={group.name}><th scope="row">{group.name}</th><td>{group.precedence ?? "Unspecified"}</td><td>{group.roleArn ?? "No IAM role"}</td></tr>)}</tbody></table></div>{!result.groups.length ? <p>No groups returned for this pool.</p> : null}</> : <p>Inspect authentication to read groups from the selected deployment-owned user pool.</p>}<p className="muted">Cognito groups influence token claims. Application RBAC, identity-pool role selection and IAM authorization are independent.</p></section>;
}

function PoolRelationships({ result }: { readonly result?: IdentityPoolsObservation }) {
  return <>{result?.pools.map(pool => <section className="identity-card" key={pool.id}><h2>{pool.name}</h2><p><code>{pool.id}</code> <span className="auth-evidence-tag">AWS metadata observed</span></p><dl className="auth-metadata"><div><dt>Guest identities</dt><dd>{pool.guests ? "Enabled — inspect unauthenticated role permissions" : "Disabled"}</dd></div><div><dt>User-pool providers</dt><dd>{pool.providers.map(provider => <div key={provider.clientId}>{provider.name}<br />Client <code>{provider.clientId}</code></div>)}</dd></div></dl><details open><summary>Role selection and mapping</summary><pre>{JSON.stringify({ roles: pool.roles, mappings: pool.mappings }, null, 2)}</pre></details><p className="muted">These role mappings do not prove successful credential issuance or effective AWS access.</p></section>)}{result && !result.pools.length ? <section className="identity-card"><h2>No owned deployed identity pools found</h2><p>This inspection covers resources in verified stacks for the selected deployment. Retained and external pools may exist separately.</p></section> : null}</>;
}

/** One route owner keeps all four panels and their drafts mounted. AWS reads are
 * bound to the exact environment/profile/target/region and source revision. */
export function AuthenticationWorkspace() {
  const { mode, snapshot, model, draft, draftState, select, live } = useStudio();
  const pathname = useLocation({ select: location => location.pathname });
  const section: Section = sections.find(entry => pathname.endsWith(`/${entry.id}`))?.id ?? "user-pools";
  const source = useQuery({ queryKey: ["identity-source", mode, snapshot.revision], queryFn: ({ signal }) => identityApi.source(mode, signal) });
  const overview = useQuery({ queryKey: ["deploy", "overview"], queryFn: () => deployApi.overview() });
  const [selections, setSelections] = useState<Partial<Record<Mode, IdentitySelection>>>({});
  const candidate = selections[mode];
  const selection = candidate && (!candidate.deployment || overview.data?.targets.some(target => target.name === candidate.deployment && target.mode === mode)) ? candidate : authenticationSelection(mode, overview.data);
  const selectedTarget = overview.data?.targets.find(target => target.name === selection.deployment && target.mode === mode);
  const sourceInputsFile = source.data?.file ?? `cdk-app/.env.${mode}`;
  const normalizeInputPath = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "");
  const targetInputsMismatch = !!selectedTarget?.inputs && normalizeInputPath(selectedTarget.inputs) !== normalizeInputPath(sourceInputsFile);
  const contextKey = JSON.stringify([mode, selection.profile, selection.deployment, selection.region, selectedTarget?.account ?? ""]);
  const [observations, setObservations] = useState<Record<string, Inspection>>({});
  const observation = observations[contextKey];
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const currentKey = useRef(contextKey); currentKey.current = contextKey;
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const creation = draft.creation();
  const cog = observation?.cognito?.data;
  const pools = observation?.pools?.data;
  const evidence = section === "identity-pools" || section === "permissions" ? observation?.pools : observation?.cognito;
  const sourceStale = !!evidence && (evidence.revision !== snapshot.revision || evidence.hash !== source.data?.hash);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const timeStale = !!evidence && clock - Date.parse(evidence.data.context.observedAt) > 5 * 60_000;
  useEffect(() => { request.current?.abort(); setBusy(false); return () => request.current?.abort(); }, [contextKey]);
  useEffect(() => { panelHeading.current?.focus({ preventScroll: true }); }, [section]);
  const updateSelection = (patch: Partial<IdentitySelection>) => {
    const next = { ...selection, ...patch };
    setSelections(current => ({ ...current, [mode]: next }));
    // Reuse Deploy's remembered destination authority, without running discovery.
    void deployApi.preferences({ profile: next.profile, deployment: next.deployment }).catch(() => {});
  };
  const inspect = async (onlyCognito = false, nextToken?: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const key = contextKey, revision = snapshot.revision, hash = source.data?.hash ?? "";
    setBusy(true);
    const kinds = onlyCognito ? ["cognito"] as const : ["cognito", "pools"] as const;
    await Promise.all(kinds.map(async kind => {
      try {
        const data = await identityApi.inspect<CognitoObservation | IdentityPoolsObservation>(kind, selection, kind === "cognito" ? nextToken : undefined, kind === "cognito" ? nextToken ? appliedSearch : search : undefined, controller.signal);
        if (controller.signal.aborted || currentKey.current !== key) return;
        if (!data?.context || data.context.profile !== selection.profile || data.context.deployment !== selection.deployment || data.context.region !== selection.region) throw new Error("Inspection returned a different destination. Select the intended context and inspect again.");
        setObservations(current => ({ ...current, [key]: { ...current[key], [kind]: { data, revision, hash }, errors: { ...current[key]?.errors, [kind]: undefined } } }));
        if (kind === "cognito" && !nextToken) setAppliedSearch(search);
      } catch (reason) {
        if (!controller.signal.aborted && currentKey.current === key) setObservations(current => ({ ...current, [key]: { ...current[key], errors: { ...current[key]?.errors, [kind]: inspectionErrorMessage(reason) } } }));
      }
    }));
    if (!controller.signal.aborted && currentKey.current === key) { setBusy(false); setClock(Date.now()); }
  };
  const canAuthor = !draftState.busy && !draft.conflict && !model.stale && !live.evaluating;
  const createPool = () => draft.requestNavigation(() => { draft.beginCreation("stack"); const entry = draft.creation()!; draft.setCreation("stack", { ...entry.form, template: "identity-pool", scope: mode }); });
  const declaredPools = model.resources.filter(resource => resource.kind === "member" && /(?:Cfn)?IdentityPool$/.test(resource.typeText ?? ""));
  const declaredUserPool = model.resources.find(resource => resource.kind === "member" && /(?:I)?UserPool$/.test(resource.typeText ?? ""));
  return <div className="authentication-workspace">
    <div className="workspace-toolbar auth-navigation"><NavigationStrip className="workspace-page-width" label="Cognito sections" activeKey={section}>{sections.map(entry => <Link key={entry.id} to={entry.to} search={(previous: { select?: string }) => previous} aria-current={section === entry.id ? "page" : undefined}>{entry.label}</Link>)}</NavigationStrip></div>
    <header className="workspace-toolbar auth-context"><div className="workspace-page-width auth-context-content"><div className="auth-workspace-title"><h1 className="workspace-page-title">Cognito</h1><SourceEnvironment /><span className="spacer" /><SourceHistory /></div>
      <div className="auth-context-controls inspection-controls"><label>Profile<input aria-label="Identity AWS profile" disabled={overview.isPending || !!overview.error} value={selection.profile} onChange={event => updateSelection({ profile: event.target.value })} list="authentication-profiles" /><datalist id="authentication-profiles">{overview.data?.profiles.map(profile => <option key={profile.name} value={profile.name} />)}</datalist></label>
        <label>Deployment<select aria-label="Identity deployment" disabled={overview.isPending || !!overview.error} value={selection.deployment} onChange={event => { const target = overview.data?.targets.find(target => target.name === event.target.value); updateSelection({ deployment: event.target.value, region: target?.region ?? selection.region, profile: overview.data?.preferences?.profiles[event.target.value] ?? selection.profile }); }}><option value="">Select a deployment</option>{overview.data?.targets.filter(target => target.mode === mode).map(target => <option key={target.name} value={target.name}>{target.name}</option>)}</select></label>
        <label>Region<input aria-label="Identity AWS region" disabled={overview.isPending || !!overview.error} value={selection.region} readOnly={!!selectedTarget?.region} title={selectedTarget?.region ? "Pinned by the deployment target" : undefined} onChange={event => updateSelection({ region: event.target.value })} /></label>
        <button className="primary" disabled={busy || overview.isPending || !!overview.error || !selectedTarget || !selection.profile || !selection.deployment || !selection.region || source.isPending} onClick={() => void inspect()}>{busy ? "Inspecting…" : "Inspect authentication"}</button>
      </div>
      <div className="auth-context-evidence" role="status"><span><strong>Source</strong> {source.isPending ? "Loading…" : source.error ? "Unavailable" : `${mode === "dev" ? "Development" : "Production"} declarations`}</span><span><strong>AWS metadata</strong> {evidence ? `${sourceStale || timeStale ? "Stale · " : "Observed · "}${new Date(evidence.data.context.observedAt).toLocaleString()} · account ${evidence.data.context.account}` : "Unverified for this context"}</span><span><strong>Sign-in / effective access</strong> Unverified</span></div>
      <div className="auth-context-support"><p className="auth-input-source"><strong>Source inputs</strong> <code>{sourceInputsFile}</code>{targetInputsMismatch ? <> · Deployment inputs <code>{selectedTarget?.inputs}</code></> : null}</p><details className="auth-boundaries"><summary>Evidence and action boundaries</summary><p>Inspect reads verified deployment-owned AWS resources. Source actions propose TypeScript for review; Apply source never deploys infrastructure. User/group operations require their own exact live-operation review. IAM simulation evaluates saved source policy and does not establish issued credentials, deployed IAM or application RBAC.</p><p>Profile/deployment defaults reuse Deploy preferences. Evidence is isolated by environment, profile, deployment and region. Changing context never transfers an AWS observation or an operation approval.</p></details></div>
      {targetInputsMismatch ? <p className="auth-notice" role="status">This deployment uses different inputs. Google input-presence evidence and retention settings here refer to <code>{sourceInputsFile}</code>; the deployment’s input presence and freshness are unverified. Review <code>{selectedTarget?.inputs}</code> in Deploy. Provider declarations still follow the selected environment.</p> : null}
      {sourceStale || timeStale ? <p className="auth-notice" role="status">{sourceStale ? "Source changed since inspection." : "Inspection is more than five minutes old."} Previous metadata is retained; inspect again before relying on it.</p> : null}
      {overview.error ? <div className="workspace-alert" role="alert"><span>Deployment context could not load: {overview.error.message}</span><button className="quiet" disabled={overview.isFetching} onClick={() => void overview.refetch()}>Retry context</button></div> : null}
      {!overview.isPending && !selectedTarget ? <p className="auth-notice">No {mode === "dev" ? "development" : "production"} deployment is declared. Source proposals are still available; configure a target in Deploy before AWS inspection.</p> : null}
      {source.error ? <div className="workspace-alert" role="alert"><span>{source.error.message}</span><button className="quiet" disabled={source.isFetching} onClick={() => void source.refetch()}>Retry source</button></div> : null}
      {source.data?.problems.map(problem => <p className="workspace-alert" role="alert" key={problem}>{problem}</p>)}
      {Object.entries(observation?.errors ?? {}).map(([kind, error]) => error ? <p className="workspace-alert" role="alert" key={kind}>{kind === "cognito" ? "User-pool" : "Identity-pool"} inspection failed: {error} {observation?.[kind as "cognito" | "pools"] ? "Previous metadata remains visible." : "No metadata verified."}</p> : null)}
      {cog?.warnings.length ? <details className="auth-boundaries"><summary>User-pool inspection notes ({cog.warnings.length})</summary>{cog.warnings.map(warning => <p key={warning}>{warning}</p>)}</details> : null}
      {pools?.warnings.length ? <details className="auth-boundaries"><summary>Identity-pool inspection notes ({pools.warnings.length})</summary>{pools.warnings.map(warning => <p key={warning}>{warning}</p>)}</details> : null}

    </div></header>
    <div className="workspace-page-width auth-content"><h2 className="auth-section-title" ref={panelHeading} tabIndex={-1}>{sections.find(entry => entry.id === section)?.label}</h2>
      <div className="auth-panel" hidden={section !== "user-pools"}>
        <section className="identity-card auth-pool-summary"><div className="auth-inline-action"><div><h2>{cog?.pool.name ?? "Application user pool"}</h2><p className="auth-summary-evidence"><span className="auth-evidence-tag">{cog ? "AWS metadata observed" : "Deployment unverified"}</span><span>{cog ? <code>{cog.poolId}</code> : "A source declaration alone does not prove a deployed pool."}</span></p></div>{declaredUserPool ? <button className="quiet" onClick={() => select(declaredUserPool.id)}>Inspect source declaration</button> : null}</div>
          {cog ? <dl className="auth-metadata"><div><dt>Estimated users</dt><dd>{cog.pool.estimatedUsers ?? "Unknown"}</dd></div><div><dt>Deletion protection</dt><dd>{cog.pool.deletionProtection ?? "Unknown"}</dd></div><div><dt>Hosted domain</dt><dd>{cog.pool.customDomain ?? cog.pool.domain ?? "Not returned"}</dd></div></dl> : <p className="muted">Select a deployment and inspect authentication to load its pool, app clients, users and groups.</p>}
          {cog?.management ? <p><strong>Management:</strong> {cog.management === "external-reference" ? `Externally referenced from ${cog.originalDeployment}; pool and client configuration remain externally managed.` : "Framework-managed User Pool."}{cog.selectedClientId ? <> Selected existing app client: <code>{cog.selectedClientId}</code>.</> : null}</p> : null}
          <div className="auth-related"><Link to="/cognito/providers" search={(previous: { select?: string }) => previous}>Set up federation</Link><Link to="/cognito/identity-pools" search={(previous: { select?: string }) => previous}>Connect AWS access</Link><Link to="/cognito/permissions" search={(previous: { select?: string }) => previous}>Inspect permissions</Link></div>
        </section>
        <section className="identity-card"><h2>App clients <span className="muted">{cog ? `(${cog.clients.length})` : ""}</span></h2>{cog?.clients.map(client => <details key={client.id} open><summary>{client.name ?? client.id}</summary><dl className="auth-metadata"><div><dt>Client ID</dt><dd><code>{client.id}</code></dd></div><div><dt>Providers</dt><dd>{client.providers.join(", ") || "None returned"}</dd></div><div><dt>Callbacks</dt><dd>{client.callbacks.join(", ") || "None"}</dd></div><div><dt>Logout URLs</dt><dd>{client.logout.join(", ") || "None"}</dd></div></dl></details>)}{!cog?.clients.length ? <p>{cog ? "No app clients returned." : "Inspect authentication to observe app-client configuration."}</p> : null}</section>
        <section className="identity-card"><h2>Users</h2><form className="identity-toolbar" onSubmit={event => { event.preventDefault(); void inspect(true); }}><label>Username starts with<input aria-label="Search Cognito users" value={search} maxLength={128} onChange={event => setSearch(event.target.value)} /></label><button className="quiet" disabled={busy || !selection.deployment || !selection.profile}>Search users</button></form>{cog ? <><div className="auth-table"><table><thead><tr><th>Username</th><th>Status</th><th>Enabled</th><th>Created</th></tr></thead><tbody>{cog.users.map(user => <tr key={user.username}><th scope="row">{user.username}</th><td>{user.status ?? "Unknown"}</td><td>{user.enabled ? "Yes" : "No"}</td><td>{user.createdAt ?? "Unknown"}</td></tr>)}</tbody></table></div>{!cog.users.length ? <p>No users returned for this page and search.</p> : null}<button className="quiet" disabled={busy || !cog.nextToken} onClick={() => void inspect(true, cog.nextToken)}>Next page</button></> : <p>Users are unverified until an explicit AWS inspection.</p>}</section>
        <Groups result={cog} />
        <CognitoManagement selection={selection} active={section === "user-pools"} onChanged={() => setObservations(current => ({ ...current, [contextKey]: { ...current[contextKey], cognito: undefined } }))} />
        <details className="identity-card"><summary>Retention and retained pool reuse</summary>{targetInputsMismatch ? <p>Retention editing is unavailable for this deployment’s custom inputs. Review <code>{selectedTarget?.inputs}</code> in Deploy; the retention editor supports the standard <code>{sourceInputsFile}</code> inputs only.</p> : <DataRetention kind="cognito" selection={{ ...selection, mode }} />}</details>
      </div>
      <div className="auth-panel" hidden={section !== "identity-pools"}>
        <section className="identity-card"><h2>Scoped AWS access</h2><ol className="auth-access-chain" aria-label="AWS access relationship"><li>User Pool<span>Identity and authentication claims</span></li><li>Identity Pool<span>Claims select a role</span></li><li>IAM role<span>Policies authorize AWS calls</span></li></ol><p>Keep application RBAC in your application. An identity pool exchanges trusted tokens for scoped AWS credentials.</p><div className="auth-source-action"><button className="primary" disabled={!canAuthor} aria-describedby="identity-pool-source-help" onClick={createPool}>Create identity pool source</button><p id="identity-pool-source-help" className="small muted">Reviewed native source connects the application pool/client. Default roles have no AWS API grants; guest access and classic flows start disabled.</p></div></section>
        <section className="identity-card"><h2>Declared identity pools</h2>{declaredPools.map(resource => <p key={resource.id}><button className="linkish" onClick={() => select(resource.id)}>{resource.path.join(".")}</button> <span className="auth-evidence-tag">{resource.absent ? "Excluded from this environment" : "Source declaration"}</span> · deployment unverified by source</p>)}{!declaredPools.length ? <p>No typed identity-pool declarations recognized. Create reviewed source above, or inspect custom native resources in your editor.</p> : null}<Link to="/cognito/permissions" search={(previous: { select?: string }) => previous}>Review reader policies and simulate permissions</Link></section>
        <PoolRelationships result={pools} />
      </div>
      <div className="auth-panel" hidden={section !== "providers"}>
        <section className="identity-card"><div className="auth-inline-action"><div><h2>Add federation</h2><p>Propose an OIDC or SAML provider on the existing user pool and app client. Secret references are declared in source; their values stay out of Studio.</p></div><button className="primary" disabled={!canAuthor} onClick={() => draft.requestNavigation(() => draft.beginCreation("auth-provider"))}>Add federation provider</button></div></section><ProviderEvidence source={source.data} result={cog} />
      </div>
      <div className="auth-panel" hidden={section !== "permissions"}>
        <section className="identity-card"><h2>Permission layers</h2><dl className="auth-metadata"><div><dt>Application RBAC</dt><dd>Application code decides record and feature access.</dd></div><div><dt>Cognito groups</dt><dd>Group membership and precedence influence token role claims.</dd></div><div><dt>Identity-pool mapping</dt><dd>Trusted claims select an IAM role; ambiguous mappings can deny credentials.</dd></div><div><dt>IAM authorization</dt><dd>Role policies, explicit Deny, boundaries and SCPs govern AWS calls.</dd></div></dl></section><Groups result={cog} /><PoolRelationships result={pools} />
        <IdentityPolicyEditor profile={selection.profile} region={selection.region} account={selectedTarget?.account ?? pools?.context.account ?? cog?.context.account} contextKey={contextKey} contextLabel={`${mode} · ${selection.deployment} · ${selection.profile} · ${selection.region}${selectedTarget?.account ? ` · account ${selectedTarget.account}` : ""}`} active={section === "permissions"} />
      </div>
      {draftState.error ? <p className="workspace-alert" role="alert">{draftState.error}</p> : null}{draft.dirty ? <DraftFooter /> : null}
    </div>
    {creation ? <CreationWizard entry={creation} back={() => draft.discard()} /> : null}
  </div>;
}



