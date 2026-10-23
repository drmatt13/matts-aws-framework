import { createHash } from "node:crypto";
import { acquireDeploymentLock } from "./deployment-workspace";

/** Per-checkout physical-resource exclusion, independent of destination name.
 * AWS ownership inspection remains necessary across checkouts/machines. */
export function acquireStatefulReferenceLocks(cache: string, stacks: readonly { template: any }[], destination: { account: string; region: string }): () => void {
  const selected = new Map<string, string>();
  for (const stack of stacks) {
    const metadata = stack.template.Metadata?.["framework:stateful-reference"];
    if (!metadata) continue;
    const physicalId = metadata.kind === "database" ? metadata.reference?.instanceIdentifier : metadata.kind === "cognito" ? metadata.reference?.userPoolId : undefined;
    if (typeof physicalId !== "string" || !physicalId) throw new Error("Cannot lock an invalid retained-resource physical identity. Review recovery again.");
    const identity = `${destination.account}/${destination.region}/${metadata.kind}/${physicalId}`;
    selected.set("stateful-" + createHash("sha256").update(identity).digest("hex"), `${metadata.kind} ${physicalId}`);
  }
  const releases: (() => void)[] = [];
  try {
    for (const key of [...selected.keys()].sort()) {
      try { releases.push(acquireDeploymentLock(cache, key)); }
      catch (error) { throw new Error(`Retained-resource operation for ${selected.get(key)} cannot start. ${error instanceof Error ? error.message : "Inspect the local reference lock and AWS outcome before retrying."}`); }
    }
  } catch (error) { for (const release of releases.reverse()) release(); throw error; }
  return () => { for (const release of [...releases].reverse()) release(); };
}
