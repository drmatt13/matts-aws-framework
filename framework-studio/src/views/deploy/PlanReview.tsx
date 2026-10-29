import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";

import { TextInput } from "../../ui/FormControls";

import { flagClasses, sectionTitleClasses, logClasses, planBannerClasses } from "./DeployUI";
import { dialogClasses, dialogHeaderClasses, dialogTitleClasses, dialogBodyClasses, dialogFooterClasses, checkGridClasses, checkMessageClasses, checkClasses } from "../../inspector-ui";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronRight, ShieldAlert } from "lucide-react";
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
    <tr data-action={change.action} className={cx("group/change", risky && "bg-[color-mix(in_srgb,var(--refuse-wash)_60%,transparent)]")}>
      <td className={"text-meta font-semibold tracking-[0.05em] whitespace-nowrap uppercase group-data-[action=add]/change:text-accept group-data-[action=remove]/change:text-refuse group-data-[action=modify]/change:text-local"}>{change.action}</td>
      <td><code>{change.logicalId}</code></td>
      <td className={"min-w-[112px] text-graphite"}>{change.type.replace(/^AWS::/, "")}</td>
      <td>
        {change.replacement === "True" ? <span data-ui="flag" className={flagClasses("bad")}>replaces</span> : change.replacement === "Conditional" ? <span data-ui="flag" className={flagClasses("warn")}>may replace</span> : change.replacement === "Unknown" && change.action === "modify" ? <span data-ui="flag" className={flagClasses()}>replacement unknown</span> : null}
        {change.stateful ? <span data-ui="flag" className={flagClasses("warn")}>holds data</span> : null}
        {change.action === "remove" && change.deletionPolicy && change.deletionPolicy !== "Delete" ? <span data-ui="flag" className={flagClasses()}>{change.deletionPolicy.toLowerCase()}</span> : null}
        {change.details?.length ? <span className={"block text-meta text-graphite"}>{change.details.join(", ")}</span> : null}
        {change.owner ? <span className={"text-caption text-graphite"}>{change.owner}</span> : null}
        {change.before !== undefined || change.after !== undefined ? <details><summary>Inspect property values</summary><div className={"min-w-0 max-w-full [&_pre]:max-h-60 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:text-caption [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere"}><strong>Before</strong><pre>{JSON.stringify(change.before ?? null, null, 2)}</pre><strong>After</strong><pre>{JSON.stringify(change.after ?? null, null, 2)}</pre></div></details> : null}
        {/AWS::(EC2::(VPCEndpoint|NatGateway)|ECS::Service|RDS::DBInstance|ElasticLoadBalancingV2::LoadBalancer)/.test(change.type) && change.action !== "remove" ? <span data-ui="flag" className={flagClasses("warn")}>ongoing AWS charges; review instance count, zones and usage</span> : null}
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
  const { data: plan, error, isPending, refetch } = useQuery({ queryKey: ["deploy", "plan", props.planKey], queryFn: () => deployApi.plan(props.planKey), refetchOnWindowFocus: false });
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
    <dialog ref={dialog} data-ui="plan-review" className={cx(dialogClasses(), plan?.identity.mode === "prod" ? "border-t-4 border-t-prod" : plan?.identity.mode === "dev" ? "border-t-4 border-t-dev" : undefined)} aria-labelledby="plan-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
      <header className={dialogHeaderClasses}>
        <h2 className={cx(dialogTitleClasses, "flex flex-wrap items-center gap-2 wrap-anywhere")} id="plan-title">Review plan for {name || "…"} {plan ? <DeploymentBadge kind={plan.identity.mode} /> : null}</h2>
        {plan ? (
          <p className={"text-caption text-graphite"}>
            {plan.review === "change-set" ? "CloudFormation change sets" : "Template comparison"} · {plan.identity.account} · {plan.identity.region} · made {relativeTime(plan.createdAt)}
            {plan.expired ? " · expired" : ` · expires ${new Date(plan.expiresAt).toLocaleString()}`}
            {plan.profile ? ` · profile ${plan.profile}` : ""}
          </p>
        ) : null}
        {plan?.inputsFile ? <p className={"text-caption text-graphite"}>Reviewed inputs: <code>{plan.inputsFile}</code>{plan.sourceRevision?.commit ? <> · source <code>{plan.sourceRevision.commit.slice(0, 7)}{plan.sourceRevision.dirty ? "+ local edits" : ""}</code></> : null}</p> : null}
      </header>
      <div className={dialogBodyClasses} aria-busy={isPending}>
        {error ? <div className={"grid justify-items-start gap-2 [&>p]:m-0"} role="alert"><p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"}>{error instanceof Error ? error.message : String(error)}</p><button className={buttonClasses({ variant: "quiet", size: "regular" })} onClick={() => void refetch()}>Try again</button></div> : null}
        {isPending ? <p className={"text-graphite"} role="status">Reading the plan…</p> : null}
        {plan ? (
          <>
            {plan.result ? (
              <p className={planBannerClasses(plan.result.status === "succeeded" ? "ok" : "warn")}>
                {plan.result.status === "succeeded" ? <Check size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
                {plan.result.status === "succeeded" ? "Infrastructure applied and verified in AWS. Application health is a separate check." : plan.result.status === "partial" ? `Applied. Still to plan now that their dependencies exist: ${plan.result.deferred.map((stack) => shortStack(stack, name)).join(", ")}.` : plan.result.status === "export-failed" ? "Infrastructure verified; exporting local settings failed. Retry the export separately." : `Deployment outcome: ${plan.result.status}. Inspect completed and remaining work before planning again.`}
              </p>
            ) : plan.status === "no-changes" ? (
              <p className={planBannerClasses("ok")}><Check size={15} aria-hidden /> Current assembly stacks have no template changes. Nothing to apply{plan.retainedStacks?.length ? "; other deployed stacks listed below are kept" : ""}. Drift and application health are separate checks.</p>
            ) : plan.status === "blocked" ? (
              <p className={planBannerClasses("bad")}>Analysis is incomplete. Resolve the review errors and plan again; applying is blocked.</p>
            ) : plan.status === "needs-secrets" ? (
              <div className={planBannerClasses("warn")}>
                <AlertTriangle size={15} aria-hidden />
                <span>A change set can only reference a secret that exists. Create {secretsChanging.filter((secret) => secret.action === "create").map((secret) => secret.name).join(", ")} now so CloudFormation can plan against {secretsChanging.filter((secret) => secret.action === "create").length === 1 ? "it. Nothing reads it" : "them. Nothing reads them"} until you apply.{secretsChanging.some((secret) => secret.action === "update") ? " Existing secrets with new values are not written now: they are updated when you apply the reviewed plan." : ""}</span>
              </div>
            ) : plan.expired ? (
              <p className={planBannerClasses("warn")}><AlertTriangle size={15} aria-hidden /> This plan expired. Plan again: AWS may have changed since.</p>
            ) : null}
            <p className={"text-caption text-graphite"}>This review deploys saved templates and staged asset bytes. Newer source edits are not included; plan current source to review them. Source application, database changes and local startup are separate actions.</p>
            {plan.result?.problem ? <p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"} role="alert">{plan.result.problem}</p> : null}
            {plan.result?.secretUpdates?.length ? <p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"}>Secret writes already performed: {plan.result.secretUpdates.join(", ")}. Runtime readers may already use these versions.</p> : null}
            {plan.result?.verification.stacks.map((stack) => <p key={stack.name} className={stack.problem ? "border-l-[3px] border-refuse py-0.5 pl-[10px]" : "text-caption"}>{shortStack(stack.name, name)}: {stack.problem ?? "template and identity verified"}</p>)}
            {plan.retainedStacks?.length ? <section aria-label="Deployed stacks kept"><h3>Deployed stacks outside this assembly — kept</h3><p className={"text-caption"}>These remain in AWS, including their data and ongoing costs. Review identity-based deletion separately; this plan does not remove them.</p><ul>{plan.retainedStacks.map((stack) => <li key={stack.name}><code>{stack.name}</code> · {stack.status}</li>)}</ul></section> : null}
            {plan.reviewEvidence ? <section aria-label="Review evidence"><h3>Review evidence</h3>{plan.reviewEvidence.problems.map((message) => <p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"} role="alert" key={message}>{message}</p>)}<details open={plan.iamBroadening || Boolean(plan.reviewEvidence.problems.length)}><summary>IAM and security diff</summary><pre className={cx(logClasses, "max-h-[320px] border")}>{plan.reviewEvidence.security}</pre></details><details><summary>Full template diff</summary><pre className={cx(logClasses, "max-h-[320px] border")}>{plan.reviewEvidence.templates}</pre></details></section> : null}

            <div className={checkGridClasses}>
              <div className={checkClasses(plan.guard === "conflict" ? "refused" : "ok")}><strong><Check size={14} aria-hidden /> Ownership</strong><div className={checkMessageClasses}>{plan.guard === "absent" ? "A first deployment: nothing of this name exists." : `AWS holds ${name} (${plan.guard}); every stack is this deployment's.`}</div></div>
              <div className={checkClasses(plan.iamBroadening || plan.status === "blocked" ? "refused" : "ok")}><strong>{plan.iamBroadening ? <ShieldAlert size={14} aria-hidden /> : <Check size={14} aria-hidden />} Permissions</strong><div className={checkMessageClasses}>{plan.status === "blocked" ? "Impact unknown: analysis must succeed before applying." : plan.iamBroadening ? "IAM or security permissions broaden. Inspect the security diff in this review." : "No IAM or security broadening detected."}</div></div>
              <div className={checkClasses(replacing.length || removing.length || stateful.length ? "refused" : "ok")}><strong>Resources</strong><div className={checkMessageClasses}>{counts(changes)}{replacing.length ? `; ${replacing.length} replaced` : ""}{stateful.length ? `; ${stateful.length} holding data changed` : ""}.</div></div>
              <div className={checkClasses(exportsInUse.length ? "refused" : "ok")}><strong>Cross-stack exports</strong><div className={checkMessageClasses}>{exportsInUse.length ? exportsInUse.map((entry) => `${entry.exportName} is ${entry.change} but imported by ${entry.importers.join(", ")}`).join("; ") : "No export another stack imports is removed or changed."}</div></div>
            </div>

            <section aria-label="Changes by stack">
              <h3 className={sectionTitleClasses}>Changes by stack</h3>
              <ul className={"m-0 grid list-none gap-2 p-0 [&>li]:min-w-0"}>
                {plan.stacks.map((stack) => (
                  <li key={stack.name}>
                    <button className={"group/stack grid min-h-9 w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-md border border-rule bg-paper px-3 py-2 text-left text-inherit wrap-anywhere enabled:hover:border-rule-strong enabled:hover:bg-wash disabled:cursor-default [&>strong]:col-start-2 [&>strong]:min-w-0 [&>span]:col-start-2 [&>span]:min-w-0 [&>span]:text-step-minus1 [&>[data-ui=flag]]:col-start-3 [&>[data-ui=flag]]:row-span-2 [&>[data-ui=flag]]:row-start-1 [&>[data-ui=flag]]:m-0"} aria-expanded={stack.changes.length ? Boolean(open[stack.name]) : undefined} onClick={() => setOpen({ ...open, [stack.name]: !open[stack.name] })} disabled={!stack.changes.length}>
                      <ChevronRight size={14} className={"col-start-1 row-span-2 row-start-1 transition-transform duration-120 group-aria-expanded/stack:rotate-90 group-disabled/stack:invisible motion-reduce:transition-none"} aria-hidden />
                      <strong>{shortStack(stack.name, name)}</strong>
                      <span className={"text-graphite"}>{stack.deferred ? `deferred — ${stack.deferred}` : stack.noChanges ? "no changes" : counts(stack.changes)}</span>
                      {stack.changes.some((change) => replaces(change) || change.action === "remove") ? <span data-ui="flag" className={flagClasses("bad")}>review</span> : null}
                    </button>
                    {open[stack.name] ? (
                      <div><p className={"text-caption text-graphite"}>{stack.dependencies?.length ? "Runs after: " + stack.dependencies.map((dependency) => shortStack(dependency, name)).join(", ") : "No stack prerequisites in this assembly."}</p><div className={"my-2 max-w-full overflow-auto rounded-md border border-rule"} role="region" aria-label={`Resource changes in ${shortStack(stack.name, name)}`} tabIndex={0}><table className={"w-full min-w-[540px] border-collapse text-step-minus1 [&_:is(th,td)]:border-b [&_:is(th,td)]:border-rule [&_:is(th,td)]:p-2 [&_:is(th,td)]:text-left [&_:is(th,td)]:align-top [&_:is(th,td)]:wrap-anywhere [&_th]:bg-wash [&_th]:font-medium [&_th]:text-graphite [&_tr:last-child_td]:border-b-0 [&_th:first-child]:whitespace-nowrap [&_td:nth-child(2)]:min-w-45 [&_td:nth-child(2)]:max-w-65 [&_td:last-child]:min-w-40"}>
                        <caption className={"sr-only"}>Resource changes in {shortStack(stack.name, name)}</caption>
                        <thead><tr><th scope="col">Action</th><th scope="col">Resource</th><th scope="col">Type</th><th scope="col">Impact</th></tr></thead>
                        <tbody>{stack.changes.map((change) => <ChangeRow key={change.logicalId} change={change} />)}</tbody>
                      </table></div></div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>

            {plan.secrets.length ? (
              <section aria-label="Secrets">
                <h3 className={sectionTitleClasses}>Secrets <span className={"text-caption text-graphite"}>names only</span></h3>
                <ul className={"m-0 grid gap-1 pl-5 wrap-anywhere"}>{plan.secrets.map((secret) => <li key={secret.name}><code>{secret.name}</code> <span className={flagClasses(secret.action === "unchanged" ? undefined : "warn")}>{secret.action}</span></li>)}</ul>
              </section>
            ) : null}
            {plan.dockerImages.length ? (
              <section aria-label="Images">
                <h3 className={sectionTitleClasses}>Container images</h3>
                <p className={"text-caption text-graphite"}>{plan.dockerImages.length} image{plan.dockerImages.length === 1 ? "" : "s"} built with Docker if not already in ECR ({[...new Set(plan.dockerImages.map((image) => shortStack(image.stack, name)))].join(", ")}).</p>
              </section>
            ) : null}
            <section aria-label="What the plan cannot know">
              <h3 className={sectionTitleClasses}>What this plan cannot know</h3>
              <ul className={"m-0 grid gap-1 pl-5 wrap-anywhere text-step-minus1 text-graphite"}>{plan.uncertainties.map((line) => <li key={line}>{line}</li>)}</ul>
            </section>
          </>
        ) : null}
      </div>
      <footer className={dialogFooterClasses}>
        {plan && applicable && needsName ? (
          <label className={"grid min-w-0 flex-[1_1_100%] gap-2 wrap-anywhere [&_input]:w-full [&_input]:min-w-0 [&_input]:font-mono"}>
            <span className={"text-caption"}>Type <code>{name}</code> to apply: {plan.confirmation.reasons.join("; ")}.</span>
            <TextInput value={typed} onChange={(event) => setTyped(event.target.value)} aria-label={`Type ${name} to apply`} autoComplete="off" spellCheck={false} />
          </label>
        ) : <span className={"text-refuse wrap-anywhere"}>{props.busy ?? ""}</span>}
        <button className={buttonClasses({ variant: "quiet", size: "regular" })} onClick={props.onClose}>Close</button>
        {plan && !plan.result ? <button className={buttonClasses({ variant: "quiet", size: "regular" })} onClick={() => props.onDiscard(plan)} disabled={Boolean(props.busy)}>Discard plan</button> : null}
        {plan?.status === "needs-secrets" && !plan.expired ? <button data-variant="primary" className={buttonClasses({ variant: "primary", size: "regular" })} onClick={() => props.onReplan(plan, true)} disabled={Boolean(props.busy)}>Create secrets and plan again</button> : null}
        {plan && (plan.expired || plan.status === "blocked" || plan.result) ? <button data-variant="primary" className={buttonClasses({ variant: "primary", size: "regular" })} onClick={() => props.onReplan(plan, false)} disabled={Boolean(props.busy)}>Plan current source</button> : null}
        {applicable ? (
          <button data-variant="primary" className={buttonClasses({ variant: "primary", size: "regular" })} disabled={Boolean(props.busy) || (needsName && typed !== name)} onClick={() => props.onApply(plan, needsName ? typed : undefined)}>
            Apply to {plan.identity.account}
          </button>
        ) : null}
      </footer>
    </dialog>
  );
}
