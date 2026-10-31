import { FileQuestionMark, LockKeyhole, Unplug, X } from "lucide-react";
import type { ModelResource } from "../../shared/model";
import { cx } from "../ui/classes";
import { isFrameworkManagedResource } from "../../shared/framework-management";
import { useStudio } from "../studio";

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
const unattachedClasses = "bg-[#e7ac4410] text-[#996016] dark:text-[#f0b96b]";

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
        appearance === "map" ? "text-[#2fb3bc]" : "text-dev",
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
  return resource.deploymentFile ? <FrameworkManagedStatus placement={placement} /> : null;
}

export function ResourceStatus({
  resource,
  placement = "header",
}: {
  resource?: ModelResource;
  placement?: StatusPlacement;
}) {
  const { index } = useStudio();
  if (!resource) return null;
  const managed =
    !!resource.deploymentFile || isFrameworkManagedResource(resource, index.resources);
  return (
    <>
      <EnvironmentFileStatus resource={resource} placement={placement} />
      {!resource.deploymentFile && isFrameworkManagedResource(resource, index.resources) ? (
        <FrameworkManagedStatus placement={placement} />
      ) : null}
      {resource.deploymentFile && !resource.deploymentFile.exists ? (
        <p
          data-resource-status="missing"
          className={cx(
            resourceStatusClasses(placement, true),
            "bg-[#ef444410] text-[#b42318] dark:text-[#f87171]",
          )}
        >
          <X size={14} aria-hidden />
          Not generated
        </p>
      ) : null}
      {resource.stackUsage?.status === "unreferenced" ? (
        <p
          data-resource-status="unattached"
          className={cx(resourceStatusClasses(placement, managed), unattachedClasses)}
        >
          <Unplug size={14} aria-hidden />
          Not added to CDK app
        </p>
      ) : null}
      {resource.frameworkStack ? (
        <p
          data-resource-status="unattached"
          className={cx(
            resourceStatusClasses(
              placement,
              managed || resource.stackUsage?.status === "unreferenced",
            ),
            unattachedClasses,
          )}
        >
          <FileQuestionMark size={14} aria-hidden />
          Not defined in resources
        </p>
      ) : null}
    </>
  );
}
