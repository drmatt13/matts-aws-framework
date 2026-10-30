import { FileQuestionMark, LockKeyhole, Unplug, X } from "lucide-react";
import type { ModelResource } from "../../shared/model";
import { cx } from "../ui/classes";
import { isFrameworkManagedResource } from "../../shared/framework-management";
import { useStudio } from "../studio";

const resourceStatusClasses = "flex w-fit items-center gap-[6px] rounded-[5px] border border-current px-[7px] py-1 text-meta leading-[1.4]";
const unattachedClasses = cx(resourceStatusClasses, "bg-[#e7ac4410] text-[#996016] dark:text-[#f0b96b]");

export function FrameworkManagedStatus({ title }: { title?: string } = {}) {
  return <p data-resource-status="managed" title={title} className={cx(resourceStatusClasses, "bg-[#6699bb10] text-dev")}><LockKeyhole size={14} aria-hidden />Framework managed</p>;
}

/** Fixed framework input files share the ownership treatment of framework infrastructure. */
export function EnvironmentFileStatus({ resource }: { resource: ModelResource }) {
  if (!resource.deploymentFile && !resource.clientEnvironment) return null;
  if (resource.deploymentFile) return <FrameworkManagedStatus />;
  return <span data-resource-status="file-role" className={cx(resourceStatusClasses, "border-rule-strong text-graphite")}
    title="Application variables mapped to generated environment files.">
    Application
  </span>;
}

export function ResourceStatus({ resource }: { resource?: ModelResource }) {
  const { index } = useStudio();
  if (!resource) return null;
  return <>
    <EnvironmentFileStatus resource={resource} />
    {!resource.deploymentFile && isFrameworkManagedResource(resource, index.resources) ? <FrameworkManagedStatus /> : null}
    {resource.deploymentFile && !resource.deploymentFile.exists ? <p data-resource-status="missing" className={cx(resourceStatusClasses, "bg-[#ef444410] text-[#b42318] dark:text-[#f87171]")}><X size={14} aria-hidden />Not generated</p> : null}
    {resource.stackUsage?.status === "unreferenced" ? <p data-resource-status="unattached" className={unattachedClasses}><Unplug size={14} aria-hidden />Not added to CDK app</p> : null}
    {resource.frameworkStack ? <p data-resource-status="unattached" className={unattachedClasses}><FileQuestionMark size={14} aria-hidden />Not defined in resources</p> : null}
  </>;
}
