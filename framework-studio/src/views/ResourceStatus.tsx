import { FileQuestionMark, LockKeyhole, Unplug, X } from "lucide-react";
import type { ModelResource } from "../../shared/model";

export function ResourceStatus({ resource }: { resource?: ModelResource }) {
  if (!resource) return null;
  return <>
    {resource.deploymentFile && !resource.deploymentFile.exists ? <p className="resource-status missing"><X size={14} aria-hidden />Not generated</p> : null}
    {resource.stackUsage?.status === "unreferenced" ? <p className="resource-status unattached"><Unplug size={14} aria-hidden />Not added to CDK app</p> : null}
    {resource.frameworkManaged ? <p className="resource-status managed"><LockKeyhole size={14} aria-hidden />Framework managed</p> : null}
    {resource.frameworkStack ? <p className="resource-status unattached"><FileQuestionMark size={14} aria-hidden />Not defined in resources</p> : null}
  </>;
}
