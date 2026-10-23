import { useEffect, useRef, useState } from "react";
import type { IdentitySelection } from "../../shared/identity";
import type { CognitoAction, CognitoOperation, CognitoOperationRecord, CognitoOperationResult, CognitoOperationReview } from "../../shared/identity-operations";
import { call } from "../api";
import { WorkbenchDialog } from "./WorkbenchUI";

export const cognitoManagementApi = {
  history: () => call<readonly CognitoOperationRecord[]>("/identity/operations"),
  review: (selection: IdentitySelection, operation: CognitoOperation) => call<CognitoOperationReview>("/identity/operations/review", { selection, operation }),
  apply: (id: string, confirmation: string, productionConfirmation?: string) => call<CognitoOperationResult>("/identity/operations/apply", { id, confirmation, productionConfirmation }),
};
const labels: Record<CognitoAction, string> = { "create-user": "Create user without invitation", "create-group": "Create group without IAM role", "add-to-group": "Add user to group", "remove-from-group": "Remove user from group", "enable-user": "Enable user", "disable-user": "Disable user" };

/** Live-operation approval, separate from source and read-only inspection. */
export function CognitoManagement({ selection, onChanged, active = true }: { readonly selection: IdentitySelection; readonly onChanged?: () => void; readonly active?: boolean }) {
  const [action, setAction] = useState<CognitoAction>("create-user");
  const [username, setUsername] = useState(""), [email, setEmail] = useState(""), [givenName, setGivenName] = useState(""), [familyName, setFamilyName] = useState("");
  const [group, setGroup] = useState(""), [description, setDescription] = useState("");
  const [review, setReview] = useState<CognitoOperationReview>();
  const [confirmation, setConfirmation] = useState(""), [productionConfirmation, setProductionConfirmation] = useState("");
  const [busy, setBusy] = useState(false), [applying, setApplying] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<CognitoOperationResult>(), [history, setHistory] = useState<readonly CognitoOperationRecord[]>([]);
  const request = useRef(0);
  const selected = [selection.profile, selection.deployment, selection.region].join("|");
  const selectedNow = useRef(selected); selectedNow.current = selected;
  const refreshHistory = async () => setHistory(await cognitoManagementApi.history());
  useEffect(() => { request.current++; setReview(undefined); setConfirmation(""); setProductionConfirmation(""); setResult(undefined); setError(""); if (!applying) setBusy(false); void refreshHistory().catch(() => setError("Operation history is unavailable. Inspect the exact pool before considering a write.")); }, [selected]);
  // Retain entered subjects across panels, without allowing a late read to open
  // an approval after its panel has become inactive.
  useEffect(() => { if (!active) { request.current++; setReview(undefined); setConfirmation(""); setProductionConfirmation(""); if (!applying) setBusy(false); } }, [active, applying]);
  const operation = (): CognitoOperation => action === "create-user" ? { action, username, email, givenName, familyName } : action === "create-group" ? { action, group, description } : action === "add-to-group" || action === "remove-from-group" ? { action, username, group } : { action, username };
  const prepare = async () => {
    const generation = ++request.current, key = selected;
    setBusy(true); setError(""); setResult(undefined); setConfirmation(""); setProductionConfirmation("");
    try { const next = await cognitoManagementApi.review(selection, operation()); if (generation === request.current && key === selectedNow.current) setReview(next); }
    catch (error) { if (generation === request.current) setError(error instanceof Error ? error.message : "Review failed. No write was requested."); }
    finally { if (generation === request.current) setBusy(false); }
  };
  const apply = async () => {
    if (!review) return;
    const key = selected; setBusy(true); setApplying(true); setError("");
    try { const next = await cognitoManagementApi.apply(review.id, confirmation, productionConfirmation || undefined); if (key === selectedNow.current) setResult(next); setReview(undefined); await refreshHistory(); onChanged?.(); }
    catch { setReview(undefined); setError("The request or response was interrupted; the cloud outcome is not established here. Refresh operation history and inspect the exact reviewed pool before another approval. Studio does not retry the write."); await refreshHistory().catch(() => {}); }
    finally { setBusy(false); setApplying(false); }
  };
  const currentHistory = history.filter(record => record.deployment === selection.deployment && record.region === selection.region && record.profile === selection.profile);
  return <section className="identity-card" aria-label="Cognito user and group management"><h2>User and group operations</h2>
    <p>Review one action against the verified deployment-owned pool, then explicitly approve its exact user/group, pool and account. Creating users sends no invitation. Password, reset and user-deletion operations are unavailable.</p>
    <p className="muted">Profile <code>{selection.profile}</code> · deployment <code>{selection.deployment || "not selected"}</code> · {selection.region}. Review reads AWS; it does not write. Production requires separate operation-specific authorization.</p>
    {error ? <p role="alert">{error}</p> : null}
    <fieldset disabled={busy}><legend>Requested action</legend>
      <label>Action<select aria-label="Cognito management action" value={action} onChange={event => { setAction(event.target.value as CognitoAction); setReview(undefined); setResult(undefined); }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {action !== "create-group" ? <label>Username<input aria-label="Cognito management username" autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} placeholder="campaign.user@example.invalid" /></label> : null}
      {action === "create-user" ? <><label>Email<input aria-label="Cognito management email" type="email" autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} placeholder="campaign.user@example.invalid" /></label><label>Given name<input aria-label="Cognito management given name" value={givenName} onChange={event => setGivenName(event.target.value)} /></label><label>Family name<input aria-label="Cognito management family name" value={familyName} onChange={event => setFamilyName(event.target.value)} /></label><p className="muted">Cognito generates a temporary credential server-side. It is never retrieved or delivered here; this tool does not complete sign-in or assert email verification.</p></> : null}
      {action === "create-group" || action === "add-to-group" || action === "remove-from-group" ? <label>Group<input aria-label="Cognito management group" value={group} onChange={event => setGroup(event.target.value)} placeholder="campaign-reader" /></label> : null}
      {action === "create-group" ? <label>Group description<input aria-label="Cognito management group description" value={description} onChange={event => setDescription(event.target.value)} /></label> : null}
      <button className="primary" disabled={!selection.deployment || !selection.profile || !selection.region} onClick={() => void prepare()}>Review Cognito operation</button>
    </fieldset>
    {applying ? <p role="status">Applying the reviewed operation. Switching views or losing the response does not undo a request Cognito already accepted.</p> : null}
    {result ? <div role="status"><strong>{result.action} · {result.status}</strong><p>{result.message}</p><p>Account {result.account} · {result.region} · pool <code>{result.poolId}</code> · follow-up {result.verification}. Operation <code>{result.id}</code>.</p></div> : null}
    <details><summary>Operation history ({currentHistory.length})</summary><p className="muted">History excludes entered user/email/group values and raw AWS responses. Match the subject digest with your review, and correlate CloudTrail using action, pool, account, time and caller ARN before another write. Digests are correlation references, not anonymous identifiers. An interrupted record remains uncertain after restart; no write is replayed.</p><button className="quiet" disabled={busy} onClick={() => void refreshHistory().catch(() => setError("History could not be read. Inspect the exact pool before another write."))}>Refresh Cognito operation history</button>{currentHistory.map(record => <p key={record.id}>{record.startedAt} · {record.action} · {record.status} · {record.poolId}<br />Caller <code>{record.actorArn ?? "unknown"}</code> · subject <code>{record.subjectDigest}</code><br />{record.message}{record.code ? ` (${record.code})` : ""}</p>)}</details>
    {review && active ? <WorkbenchDialog title="Approve Cognito operation" busy={busy} onClose={() => setReview(undefined)} footer={<><button className="quiet" disabled={busy} onClick={() => setReview(undefined)}>Cancel</button><button className="primary" disabled={busy || confirmation !== review.confirmation || !!review.productionConfirmation && productionConfirmation !== review.productionConfirmation} onClick={() => void apply()}>{review.noEffect ? "Record reviewed unchanged state" : "Apply exact Cognito operation"}</button></>}>
      <p><strong>{review.target.mode === "prod" ? "PRODUCTION" : "Development"}</strong> · account <code>{review.target.account}</code> · {review.target.region} · profile {review.target.profile}</p><p>Pool <code>{review.target.poolId}</code><br /><code>{review.target.poolArn}</code></p>{review.target.actorArn ? <p>Caller <code>{review.target.actorArn}</code></p> : null}
      <p><strong>{labels[review.operation.action]}</strong></p><pre>{JSON.stringify(review.operation, null, 2)}</pre><p>Subject correlation digest <code>{review.subjectDigest}</code>. Save this review reference if you need to correlate a later uncertain outcome.</p><p>Current user: {review.before.user ? `${review.before.user.username} · ${review.before.user.enabled ? "enabled" : "disabled"} · ${review.before.user.status ?? "status unknown"}` : "not present / not applicable"}. Current group: {review.before.group?.name ?? "not present / not applicable"}{review.before.group?.roleArn ? ` · role ${review.before.group.roleArn}` : ""}.</p>
      <ul>{review.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>
      <label>Type <code>{review.confirmation}</code><input aria-label="Cognito operation confirmation" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      {review.productionConfirmation ? <div className="reason"><p>This changes a real production user pool. User access and future role claims can change. This approval is separate from source, deployment and prior operations.</p><label>Separately type <code>{review.productionConfirmation}</code><input aria-label="Production Cognito operation authorization" autoComplete="off" value={productionConfirmation} onChange={event => setProductionConfirmation(event.target.value)} /></label></div> : null}
    </WorkbenchDialog> : null}
  </section>;
}

