/**
 * What a deployed workload must be supplied, and the one place that decides it.
 *
 * A requirement is the author saying "this workload cannot run without X". Two
 * lanes answer that question — CDK synthesis, and the local runner — and they
 * used to answer it differently: synthesis refused an absent resource while the
 * local lane skipped the requirement and launched without the variable, message
 * and all. A workload that refuses to deploy but starts happily on a laptop is
 * the opposite of what one catalog for every lane is supposed to buy.
 *
 * So the policy lives here, once, and a lane supplies only the two things that
 * genuinely differ: how it looks a value up, and what counts as supplied. Only
 * this module imports nothing but `./resources`, which keeps it on the
 * browser-safe side and out of any cycle.
 */
import {
  formatResourceEnv,
  formatResourceReference,
  isResourceAbsent,
  isUnresolvedTokenString,
  type AnyResourceCatalog,
  type ResourceReference,
  type SecretResourceReference,
  type StringResourceReference,
} from "./resources";

/**
 * One condition/consequence pair on a deployed workload's inputs.
 *
 * Deliberately not an expression language: a condition is one string resource
 * compared to one literal, and a consequence is a list of resources that then
 * have to be supplied. Anything richer stops being comparable data — and two
 * routes sharing a target still have to agree about what they declared.
 */
export interface CloudRequirement<Catalog = AnyResourceCatalog> {
  /** When to apply this. Omitted, the requirement is unconditional. */
  readonly when?: {
    readonly resource: StringResourceReference<Catalog>;
    readonly equals: string;
  };
  /** Resources that must be supplied when the condition holds. */
  readonly require: readonly (
    | StringResourceReference<Catalog>
    | SecretResourceReference<Catalog>
  )[];
  /** Added to the diagnostic, to say why. Never contains a value. */
  readonly message?: string;
}

/** A requirement with its references checked, in the form the evaluator reads. */
export interface ResolvedCloudRequirement {
  readonly when?: {
    readonly resource: ResourceReference<"string">;
    readonly equals: string;
  };
  readonly require: readonly ResourceReference[];
  readonly message?: string;
}

/**
 * How one lane looks a resource up. The policy above it is shared.
 *
 * `supplied` is separate from `select` because the two questions differ: a
 * secret is supplied as a handle nobody can read as a string, and a CDK token
 * counts as supplied although its value does not exist yet.
 */
export interface RequirementLane {
  /** The concrete value of a `when` selector in this lane, if it has one. */
  readonly select: (reference: ResourceReference) => string | undefined;
  /** Whether a required resource is actually supplied in this lane. */
  readonly supplied: (reference: ResourceReference) => boolean;
}

/** What to tell someone whose deployment is missing a required input. */
export function describeRequirementFix(reference: ResourceReference): string {
  if (!reference.fromEnv) return "Supply it where the framework workloads are constructed.";
  // A secret's value is never read from the environment at synth: what a
  // deployment needs is the ARN the upload returned, so setting the variable is
  // only half the fix.
  return reference.kind === "secret"
    ? `Set ${reference.fromEnv} in cdk-app/.env and run npm run deploy.`
    : `Set ${formatResourceEnv(reference.fromEnv)}.`;
}

/**
 * Every requirement whose condition holds, checked against one lane.
 *
 * Presence, not validity: this proves a value was supplied, never that the
 * secret behind a handle exists, is readable, or holds a working key. The
 * workload keeps its own runtime error for that.
 *
 * Returns the references this lane must supply, so a caller that also has to
 * *mark* them required — the CDK lane, which mints a parameter for a required
 * secret — gets the set without deriving it a second time.
 */
export function assertRequirementsMet(
  requirements: readonly ResolvedCloudRequirement[],
  lane: RequirementLane,
  origin: string,
): readonly ResourceReference[] {
  const required: ResourceReference[] = [];

  for (const requirement of requirements) {
    let condition = "";

    if (requirement.when) {
      const selector = requirement.when.resource;
      condition = ` when ${formatResourceReference(selector)} is "${requirement.when.equals}"`;

      // An absent selector is a contradiction between two authored lines, not a
      // shortage this deployment happens to have. Refusing beats treating it as
      // a condition that silently never holds, which would take the whole
      // requirement — and its message — out of the build without saying so.
      if (isResourceAbsent(selector)) {
        throw new Error(
          `${origin} cloud.requirements conditions on ${formatResourceReference(selector)}, which this configuration declares as undefined. A condition compares a value the deployment holds.`,
        );
      }
      const current = lane.select(selector);
      if (current === undefined || current === null) {
        throw new Error(
          `${origin} cloud.requirements conditions on ${formatResourceReference(selector)}, which nothing supplied. ${describeRequirementFix(selector)}`,
        );
      }
      // A token has no value to compare yet, and its encoding is not one. Said
      // plainly rather than compared and silently found unequal.
      if (isUnresolvedTokenString(current)) {
        throw new Error(
          `${origin} cloud.requirements conditions on ${formatResourceReference(selector)}, whose value is not known until deployment. A condition compares a concrete deployment input, not a CDK reference.`,
        );
      }
      if (current !== requirement.when.equals) continue;
    }

    for (const reference of requirement.require) {
      required.push(reference);
      if (isResourceAbsent(reference)) {
        throw new Error(
          `${origin} ${formatResourceReference(reference)} is required${condition}, and this configuration declares it as undefined.`,
        );
      }
      // A supplied token counts as supplied: the value arrives at deploy time,
      // and this pass only proves the handle was wired up.
      if (lane.supplied(reference)) continue;
      throw new Error(
        [
          `${origin} ${formatResourceReference(reference)} is required${condition}${
            reference.kind === "secret" && reference.fromEnv
              ? ", and cdk-app/.env declares no value for it"
              : ""
          }.`,
          requirement.message,
          describeRequirementFix(reference),
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
  }

  return required;
}
