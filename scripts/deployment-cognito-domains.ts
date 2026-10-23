import { createHash } from "node:crypto";

/**
 * A production-only default must not silently migrate a domain that an older
 * development deployment already owns. Compare templates only after the normal
 * deployment/account/stack ownership checks; this is not resource discovery.
 * This focused compatibility guard does not resolve intrinsic functions, drift
 * or replacement of a pool behind an unchanged Ref. Full template/change-set
 * review remains necessary for other infrastructure changes.
 */
type Resource = { Type?: string; Properties?: Record<string, unknown>; Condition?: unknown };
type Template = { Resources?: Record<string, Resource>; Conditions?: Record<string, unknown>; Parameters?: Record<string, unknown>; Mappings?: Record<string, unknown> };

export interface CognitoDomainChange {
  readonly stack: string;
  readonly logicalId: string;
  readonly previousDomain: string;
  readonly nextDomain?: string;
  readonly consequence: string;
  /** Binds public domain properties and dependent template definitions without displaying their values. */
  readonly evidenceDigest: string;
}

const stable = (value: unknown): string | undefined => JSON.stringify(value, (_key, inner) =>
  inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner);
const domainLabel = (value: unknown) => typeof value === "string" && /^[a-z0-9.-]+$/i.test(value) ? value : "(CloudFormation expression)";

/** Certificate renewal alone keeps the domain; deletion, renaming and reparenting do not. */
export function cognitoDomainChanges(stack: string, previous: Template | undefined, next: Template): CognitoDomainChange[] {
  return Object.entries(previous?.Resources ?? {}).flatMap(([logicalId, before]) => {
    if (before.Type !== "AWS::Cognito::UserPoolDomain" || !before.Properties?.CustomDomainConfig) return [];
    const after = next.Resources?.[logicalId];
    const expressions = typeof before.Properties.Domain !== "string" || typeof before.Properties.UserPoolId !== "string";
    const context = (template: Template | undefined) => ({
      ...(before.Condition ? { Conditions: template?.Conditions } : {}),
      // Ref/Fn::Sub/Fn::FindInMap can stay byte-identical while these change.
      // The native pool ID is a Ref too; conservative review is intentional
      // for older custom-domain deployments with dependent template changes.
      ...(expressions ? { Parameters: template?.Parameters, Mappings: template?.Mappings, Conditions: template?.Conditions } : {}),
    });
    if (after?.Type === before.Type && after.Properties?.CustomDomainConfig
      && stable(before.Properties.Domain) === stable(after.Properties.Domain)
      && stable(before.Properties.UserPoolId) === stable(after.Properties.UserPoolId)
      && stable(before.Condition) === stable(after.Condition)
      // A condition can keep its name while its definition (or a referenced
      // condition) changes. Conservatively review conditional-domain changes.
      && stable(context(previous)) === stable(context(next))) return [];
    const previousDomain = domainLabel(before.Properties.Domain);
    const nextDomain = after?.Type === before.Type ? domainLabel(after.Properties?.Domain) : undefined;
    const consequence = `${stack}/${logicalId}: remove or replace existing development Cognito custom domain ${previousDomain}${nextDomain ? ` with ${nextDomain}` : ""}. Hosted sign-in and federation redirect URLs can change or stop working, and the custom-domain CloudFront endpoint output may disappear; review provider redirects and DNS before this migration.`;
    const domainEvidence = (resource: Resource | undefined) => resource ? { Type: resource.Type, Domain: resource.Properties?.Domain, UserPoolId: resource.Properties?.UserPoolId, custom: Boolean(resource.Properties?.CustomDomainConfig), Condition: resource.Condition } : undefined;
    const evidenceDigest = createHash("sha256").update(stable({ before: domainEvidence(before), after: domainEvidence(after), previousContext: context(previous), nextContext: context(next) })!).digest("hex");
    return [{ stack, logicalId, previousDomain, ...(nextDomain ? { nextDomain } : {}), consequence, evidenceDigest }];
  });
}

/** Old click-only plans must be reviewed again, even if a caller types a name. */
export function assertCognitoDomainReview(
  changes: readonly CognitoDomainChange[],
  review: { readonly cognitoDomainChanges?: readonly CognitoDomainChange[]; readonly confirmation: { readonly level: string; readonly reasons: readonly string[] } },
  deployment: string,
  confirmation?: string,
): void {
  if (!changes.length) return;
  if (stable(changes) !== stable(review.cognitoDomainChanges) || review.confirmation.level !== "name"
    || changes.some(change => !review.confirmation.reasons.includes(change.consequence))) {
    throw new Error(`The review does not include the existing development Cognito custom-domain migration and its authentication consequences. Create and review a new deployment plan for ${deployment}. Nothing was changed.`);
  }
  if (confirmation !== deployment) throw new Error(`This development Cognito custom-domain migration needs --confirm ${deployment} after reviewing its authentication consequences. Nothing was changed.`);
}
