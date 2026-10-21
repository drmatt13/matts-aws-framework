import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlanView, ResourceChangeView } from "../../../shared/deploy";
import { deployApi } from "../../deploy/api";
import { DeploymentBadge } from "../DeploymentBadge";
import { relativeTime, shortStack } from "./format";

function counts(changes: readonly ResourceChangeView[]): string {
  const of = (action: string) => changes.filter((change) => change.action === action).length;
  return [["add", of("add")], ["modify", of("modify")], ["remove", of("remove")]].filter(([, count]) => count).map(([action, count]) => `${count} to ${action}`).join(", ") || "no resource changes";
}

const replaces = (change: ResourceChangeView) => change.replacement === "True" || change.replacement === "Conditional";

function ChangeRow({ change }: { readonly change: ResourceChangeView }) {
  const risky = change.action === "remove" || replaces(change) || (change.stateful && change.action !== "add");
  return (
    <tr className={`${change.action} ${risky ? "risky" : ""}`}>
      <td className="change-action">{change.action}</td>
      <td><code>{change.logicalId}</code></td>
      <td className="change-type">{change.type.replace(/^AWS::/, "")}</td>
      <td>
        {change.replacement === "True" ? <span className="flag bad">replaces</span> : change.replacement === "Conditional" ? <span className="flag warn">may replace</span> : change.replacement === "Unknown" && change.action === "modify" ? <span className="flag quiet">replacement unknown</span> : null}
        {change.stateful ? <span className="flag warn">holds data</span> : null}
        {change.action === "remove" && change.deletionPolicy && change.deletionPolicy !== "Delete" ? <span className="flag quiet">{change.deletionPolicy.toLowerCase()}</span> : null}
        {change.details?.length ? <span className="change-details">{change.details.join(", ")}</span> : null}
      </td>
    </tr>
  );
}

/**
 * A reviewed plan: what CloudFormation (or a template comparison) says will
 * change, what it cannot know, and the confirmation applying needs. Applying
 * deploys exactly what was reviewed; the deploy script refuses anything else.
 */
export function PlanReview(props: {
  readonly planKey: string;
  readonly onClose: () => void;
  readonly onApply: (plan: PlanView, confirm: string | undefined) => void;
  readonly onDiscard: (plan: PlanView) => void;
  readonly onReplan: (plan: PlanView, createSecrets: boolean) => void;
  readonly busy: string | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { data: plan, error } = useQuery({ queryKey: ["deploy", "plan", props.planKey], queryFn: () => deployApi.plan(props.planKey), refetchOnWindowFocus: false });
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  const changes = plan?.stacks.flatMap((stack) => stack.changes) ?? [];
  const replacing = changes.filter(replaces);
  const removing = changes.filter((change) => change.action === "remove");
  const stateful = changes.filter((change) => change.stateful && change.action !== "add");
  const exportsInUse = plan?.stacks.flatMap((stack) => stack.exportsInUse) ?? [];
  const secretsChanging = plan?.secrets.filter((secret) => secret.action !== "unchanged") ?? [];
  const name = plan?.identity.deployment ?? "";
  const needsName = plan?.confirmation.level === "name";
  const applicable = plan && !plan.result && !plan.expired && plan.status === "ready";

  return (
    <dialog ref={dialog} className={`preview plan-review ${plan?.identity.mode ?? ""}`} aria-labelledby="plan-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
      <header>
        <h2 id="plan-title">Review plan for {name || "…"} {plan ? <DeploymentBadge kind={plan.identity.mode} /> : null}</h2>
        {plan ? (
          <p className="small muted">
            {plan.review === "change-set" ? "CloudFormation change sets" : "Template comparison"} · {plan.identity.account} · {plan.identity.region} · made {relativeTime(plan.createdAt)}
            {plan.expired ? " · expired" : ` · expires ${new Date(plan.expiresAt).toLocaleString()}`}
          </p>
        ) : null}
      </header>
      <div className="body">
        {error ? <p className="diagnostic">{error instanceof Error ? error.message : String(error)}</p> : null}
        {!plan ? <p className="muted">Reading the plan…</p> : (
          <>
            {plan.result ? (
              <p className={`plan-banner ${plan.result.status === "succeeded" ? "ok" : "warn"}`}>
                {plan.result.status === "succeeded" ? <Check size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
                {plan.result.status === "succeeded" ? "Applied and verified in AWS." : plan.result.status === "partial" ? `Applied. Still to plan now that their dependencies exist: ${plan.result.deferred.map((stack) => shortStack(stack, name)).join(", ")}.` : "Applied, but not every stack verified. See the stacks in CloudFormation."}
              </p>
            ) : plan.status === "no-changes" ? (
              <p className="plan-banner ok"><Check size={15} aria-hidden /> AWS already holds exactly this. Nothing to apply.</p>
            ) : plan.status === "needs-secrets" ? (
              <div className="plan-banner warn">
                <AlertTriangle size={15} aria-hidden />
                <span>A change set can only reference a secret that exists. Create {secretsChanging.filter((secret) => secret.action === "create").map((secret) => secret.name).join(", ")} now so CloudFormation can plan against {secretsChanging.filter((secret) => secret.action === "create").length === 1 ? "it. Nothing reads it" : "them. Nothing reads them"} until you apply.{secretsChanging.some((secret) => secret.action === "update") ? " Existing secrets with new values are not written now: they are updated when you apply the reviewed plan." : ""}</span>
              </div>
            ) : plan.expired ? (
              <p className="plan-banner warn"><AlertTriangle size={15} aria-hidden /> This plan expired. Plan again: AWS may have changed since.</p>
            ) : null}

            <div className="checks">
              <div className={`check ${plan.guard === "conflict" ? "refused" : "ok"}`}><strong><Check size={14} aria-hidden /> Ownership</strong><div className="message">{plan.guard === "absent" ? "A first deployment: nothing of this name exists." : `AWS holds ${name} (${plan.guard}); every stack is this deployment's.`}</div></div>
              <div className={`check ${plan.iamBroadening ? "refused" : "ok"}`}><strong>{plan.iamBroadening ? <ShieldAlert size={14} aria-hidden /> : <Check size={14} aria-hidden />} Permissions</strong><div className="message">{plan.iamBroadening ? "IAM or security permissions broaden. Review the security diff in the plan's log." : "No IAM or security broadening."}</div></div>
              <div className={`check ${replacing.length || removing.length || stateful.length ? "refused" : "ok"}`}><strong>Resources</strong><div className="message">{counts(changes)}{replacing.length ? `; ${replacing.length} replaced` : ""}{stateful.length ? `; ${stateful.length} holding data changed` : ""}.</div></div>
              <div className={`check ${exportsInUse.length ? "refused" : "ok"}`}><strong>Cross-stack exports</strong><div className="message">{exportsInUse.length ? exportsInUse.map((entry) => `${entry.exportName} is ${entry.change} but imported by ${entry.importers.join(", ")}`).join("; ") : "No export another stack imports is removed or changed."}</div></div>
            </div>

            <section aria-label="Changes by stack">
              <h3 className="section-title">Changes by stack</h3>
              <ul className="plan-stacks">
                {plan.stacks.map((stack) => (
                  <li key={stack.name}>
                    <button className="plan-stack" aria-expanded={Boolean(open[stack.name])} onClick={() => setOpen({ ...open, [stack.name]: !open[stack.name] })} disabled={!stack.changes.length}>
                      <strong>{shortStack(stack.name, name)}</strong>
                      <span className="muted">{stack.deferred ? `deferred — ${stack.deferred}` : stack.noChanges ? "no changes" : counts(stack.changes)}</span>
                      {stack.changes.some((change) => replaces(change) || change.action === "remove") ? <span className="flag bad">review</span> : null}
                    </button>
                    {open[stack.name] ? (
                      <table className="change-table">
                        <tbody>{stack.changes.map((change) => <ChangeRow key={change.logicalId} change={change} />)}</tbody>
                      </table>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>

            {plan.secrets.length ? (
              <section aria-label="Secrets">
                <h3 className="section-title">Secrets <span className="small muted">names only</span></h3>
                <ul className="plain-list">{plan.secrets.map((secret) => <li key={secret.name}><code>{secret.name}</code> <span className={`flag ${secret.action === "unchanged" ? "quiet" : "warn"}`}>{secret.action}</span></li>)}</ul>
              </section>
            ) : null}
            {plan.dockerImages.length ? (
              <section aria-label="Images">
                <h3 className="section-title">Container images</h3>
                <p className="small muted">{plan.dockerImages.length} image{plan.dockerImages.length === 1 ? "" : "s"} built with Docker if not already in ECR ({[...new Set(plan.dockerImages.map((image) => shortStack(image.stack, name)))].join(", ")}).</p>
              </section>
            ) : null}
            <section aria-label="What the plan cannot know">
              <h3 className="section-title">What this plan cannot know</h3>
              <ul className="plain-list uncertainties">{plan.uncertainties.map((line) => <li key={line}>{line}</li>)}</ul>
            </section>
          </>
        )}
      </div>
      <footer>
        {plan && applicable && needsName ? (
          <label className="confirm-name">
            <span className="small">Type <code>{name}</code> to apply: {plan.confirmation.reasons.join("; ")}.</span>
            <input value={typed} onChange={(event) => setTyped(event.target.value)} aria-label={`Type ${name} to apply`} autoComplete="off" spellCheck={false} />
          </label>
        ) : <span className="reason">{props.busy ?? ""}</span>}
        <button className="quiet" onClick={props.onClose}>Close</button>
        {plan && !plan.result ? <button className="quiet" onClick={() => props.onDiscard(plan)} disabled={Boolean(props.busy)}>Discard plan</button> : null}
        {plan?.status === "needs-secrets" && !plan.expired ? <button className="primary" onClick={() => props.onReplan(plan, true)} disabled={Boolean(props.busy)}>Create secrets and plan again</button> : null}
        {plan?.expired && !plan.result ? <button className="primary" onClick={() => props.onReplan(plan, false)} disabled={Boolean(props.busy)}>Plan again</button> : null}
        {applicable ? (
          <button className="primary" disabled={Boolean(props.busy) || (needsName && typed !== name)} onClick={() => props.onApply(plan, needsName ? typed : undefined)}>
            Apply to {plan.identity.account}
          </button>
        ) : null}
      </footer>
    </dialog>
  );
}
