import { FileQuestionMark, LockKeyhole, Unplug, X } from "lucide-react";
import type { ModelResource } from "../../shared/model";
import { cx } from "../ui/classes";

const resourceStatusClasses = "flex w-fit items-center gap-[6px] rounded-[5px] border border-current px-[7px] py-1 text-meta leading-[1.4]";
const unattachedClasses = cx(resourceStatusClasses, "bg-[#e7ac4410] text-[#996016] dark:text-[#f0b96b]");

export function FrameworkManagedStatus() {
  return <p data-resource-status="managed" className={cx(resourceStatusClasses, "bg-[#6699bb10] text-dev")}><LockKeyhole size={14} aria-hidden />Framework managed</p>;
}

export function ResourceStatus({ resource }: { resource?: ModelResource }) {
  if (!resource) return null;
  return <>
    {resource.deploymentFile && !resource.deploymentFile.exists ? <p data-resource-status="missing" className={cx(resourceStatusClasses, "bg-[#ef444410] text-[#b42318] dark:text-[#f87171]")}><X size={14} aria-hidden />Not generated</p> : null}
    {resource.stackUsage?.status === "unreferenced" ? <p data-resource-status="unattached" className={unattachedClasses}><Unplug size={14} aria-hidden />Not added to CDK app</p> : null}
    {resource.frameworkManaged ? <FrameworkManagedStatus /> : null}
    {resource.frameworkStack ? <p data-resource-status="unattached" className={unattachedClasses}><FileQuestionMark size={14} aria-hidden />Not defined in resources</p> : null}
  </>;
}
