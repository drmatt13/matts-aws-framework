import { LockKeyhole, Unplug } from "lucide-react";
import type { ModelResource } from "../../shared/model";

export function ResourceStatus({ resource }: { resource?: ModelResource }) {
  if (!resource) return null;
  return <>
    {resource.stackUsage?.status === "unreferenced" ? <p className="resource-status unattached"><Unplug size={14} aria-hidden />Not added to CDK app</p> : null}
    {resource.frameworkManaged ? <p className="resource-status managed"><LockKeyhole size={14} aria-hidden />Framework managed{resource.frameworkManaged === "database" ? " · Database" : " · Environment exports"}</p> : null}
  </>;
}
