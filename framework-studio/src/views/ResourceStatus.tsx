import { FileQuestionMark, LockKeyhole } from "lucide-react";
import type { ModelResource } from "../../shared/model";
import { cx } from "../ui/classes";
import { isFrameworkManagedResource } from "../../shared/framework-management";
import { resourceIssues, type EntityIssue } from "../issues";
import { useStudio } from "../studio";
import { IssueGlyph } from "./IssueNotice";

type StatusPlacement = "header" | "inline";

/** Badge spacing belongs here, including consecutive header badges. Data attributes identify states
 * for browser tests; no parent selector controls this component's appearance. */
function resourceStatusClasses(placement: StatusPlacement | "map", stacked = false) {
  return cx(
    "flex w-fit items-center gap-1.5 rounded-[5px] border border-current px-[7px] py-1 text-meta leading-[1.4]",
    placement === "header"
      ? cx(stacked ? "-mt-1" : "mt-2.5", "mb-2.5 last:mb-0")
      : placement === "map"
        ? "m-0"
        : "mt-0 mb-2",
  );
}
/** Error and warning chip colours; issue chips and input-group entry rows share them. */
export const issueChipClasses = {
  error: "bg-[#ef444410] text-[#b42318] dark:text-[#f87171]",
  warning: "bg-[#e7ac4410] text-[#996016] dark:text-[#f0b96b]",
} as const;

/** Compact issue chips for lists such as island entries; an inspector header shows `IssueNotice` instead. */
export function IssueChips({
  issues,
  placement = "header",
  stacked = false,
}: {
  readonly issues: readonly EntityIssue[];
  readonly placement?: StatusPlacement;
  /** A status chip precedes the first one. */
  readonly stacked?: boolean;
}) {
  return (
    <>
      {issues.map((issue, at) => (
        <p
          key={issue.title}
          data-resource-status={issue.severity}
          className={cx(resourceStatusClasses(placement, stacked || at > 0), issueChipClasses[issue.severity])}
        >
          <IssueGlyph issue={issue} />
          {issue.title}
        </p>
      ))}
    </>
  );
}

export function FrameworkManagedStatus({
  title,
  placement = "header",
  appearance = "default",
  className,
}: {
  readonly title?: string;
  readonly placement?: StatusPlacement;
  readonly appearance?: "default" | "map";
  readonly className?: string;
} = {}) {
  return (
    <p
      data-resource-status="managed"
      title={title}
      className={cx(
        resourceStatusClasses(appearance === "map" ? "map" : placement),
        "bg-[#6699bb10]",
        appearance === "map" ? "text-[#2fb3bc]" : "text-[#0c7580] dark:text-dev",
        className,
      )}
    >
      <LockKeyhole size={14} aria-hidden />
      Framework managed
    </p>
  );
}

/** Fixed framework input files share the ownership treatment of framework infrastructure. Client
 * mappings are application-owned, which, like every application resource, carries no badge. */
export function EnvironmentFileStatus({
  resource,
  placement = "header",
}: {
  resource: ModelResource;
  readonly placement?: StatusPlacement;
}) {
  return resource.deploymentFile || resource.deploymentFiles ? <FrameworkManagedStatus placement={placement} /> : null;
}

/** Ownership, issue and catalog status chips. `issues={false}` leaves issues to the header's `IssueNotice`. */
export function ResourceStatus({
  resource,
  placement = "header",
  issues: showIssues = true,
}: {
  resource?: ModelResource;
  placement?: StatusPlacement;
  issues?: boolean;
}) {
  const { index } = useStudio();
  if (!resource) return null;
  const managed =
    !!resource.deploymentFile || !!resource.deploymentFiles || isFrameworkManagedResource(resource, index.resources);
  const issues = showIssues ? resourceIssues(resource, index.resources.values()) : [];
  return (
    <>
      <EnvironmentFileStatus resource={resource} placement={placement} />
      {!resource.deploymentFile && !resource.deploymentFiles && isFrameworkManagedResource(resource, index.resources) ? (
        <FrameworkManagedStatus placement={placement} />
      ) : null}
      <IssueChips issues={issues} placement={placement} stacked={managed} />
      {resource.frameworkStack ? (
        // Expected for a framework stack, so a neutral status rather than an issue.
        <p
          data-resource-status="undeclared"
          className={cx(
            resourceStatusClasses(placement, managed || issues.length > 0),
            "text-graphite",
          )}
        >
          <FileQuestionMark size={14} aria-hidden />
          Not defined in resources
        </p>
      ) : null}
    </>
  );
}
