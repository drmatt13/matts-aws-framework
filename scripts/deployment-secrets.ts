import { validateTags, sameTags, type DeclarationTags } from "@repo/framework/config";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CreateSecretCommand, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand, UntagResourceCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface SecretRequirement {
  readonly tags?: DeclarationTags;
  readonly version: 1;
  readonly path: readonly string[];
  readonly variable: string;
  readonly name: string;
  readonly deployment: string;
  readonly mode: "dev" | "prod";
  readonly account: string;
  readonly region: string;
  readonly stack: string;
  readonly parameter: string;
}
export interface SecretDeploymentResult {
  readonly parameters: readonly string[];
  readonly updated: readonly string[];
}

/** What synchronizing would do, by name: no value ever leaves the plan. */
export interface SecretPlanEntry {
  readonly name: string;
  readonly variable: string;
  readonly action: "create" | "update" | "unchanged";
}

/**
 * What a review bound each secret to, so that applying writes only what was
 * reviewed. It holds no value: an authored value is an HMAC under a random key
 * made for this plan alone, and AWS's side is the secret's ARN and the version
 * AWSCURRENT names, which no value determines. With its key, a low-entropy value
 * could be guessed, so a binding is as private as the inputs file: deploy.ts
 * keeps it beside the deployment lock, never in plan.json, a log or Studio.
 */
export interface SecretBinding {
  readonly version: 1;
  readonly planId: string;
  /** 32 random bytes, base64. */
  readonly key: string;
  readonly secrets: Readonly<Record<string, BoundSecret>>;
}

export interface BoundSecret {
  readonly action: SecretPlanEntry["action"];
  /** The complete ARN, for a secret that exists. */
  readonly arn?: string;
  /** The version AWSCURRENT names, for a secret that exists. */
  readonly current?: string;
  /** The authored value's HMAC, when one is authored. */
  readonly authored?: string;
  readonly tags?: string;
  readonly currentTags?: string;
}

/** What a review approved: the entries plan.json shows, and the binding behind them. */
export interface ReviewedSecrets {
  readonly entries: readonly SecretPlanEntry[];
  readonly binding: SecretBinding | undefined;
}

export interface SecretPlan {
  readonly entries: readonly SecretPlanEntry[];
  /** The complete ARN of each existing secret, by name: what a change set can be planned against. */
  readonly arns: Readonly<Record<string, string>>;
  /** Binds this plan's writes to the values and AWS versions it saw, under a fresh key. */
  bind(planId: string): SecretBinding;
  /** Why this plan's writes are not the ones reviewed, naming secrets only; undefined when they are. */
  mismatch(reviewed: ReviewedSecrets): string | undefined;
  /** Creates the secrets that do not exist yet and writes nothing else: no existing secret is updated. */
  createMissing(onCreate?: (name: string) => void): Promise<readonly string[]>;
  /** Performs the plan's writes, after refusing unless they are the `reviewed` ones. Values stay in this closure. */
  apply(onUpdate?: (name: string) => void, reviewed?: ReviewedSecrets): Promise<SecretDeploymentResult>;
}

interface Planned { requirement: SecretRequirement; value?: string; arn?: string; current?: string; changed: boolean; tagChanged: boolean; existingTags: DeclarationTags }

const actionOf = (plan: Planned): SecretPlanEntry["action"] => (!plan.arn ? "create" : (plan.changed || plan.tagChanged) ? "update" : "unchanged");

/** Every read and ownership check, and no write. Values are compared in memory and never returned. */
export async function planDeploymentSecrets(
  requirements: readonly SecretRequirement[], authored: Readonly<Record<string, string | undefined>>,
  identity: { account: string; region: string }, client: Pick<SecretsManagerClient, "send">,
): Promise<SecretPlan> {
  const plans = new Map<string, Planned>();
  for (const requirement of requirements) {
    validateTags(requirement.tags, `Secret ${requirement.name}`);
    if (requirement.account !== identity.account || requirement.region !== identity.region) throw new Error("Selected AWS credentials/account or region do not match the synthesized secret requirements.");
    const previous = plans.get(requirement.name);
    if (previous) {
      if (previous.requirement.variable !== requirement.variable || previous.requirement.deployment !== requirement.deployment || previous.requirement.path.join(".") !== requirement.path.join(".") || !sameTags(previous.requirement.tags, requirement.tags)) throw new Error(`Conflicting secret declarations for ${requirement.name}.`);
      continue;
    }
    const value = authored[requirement.variable] || undefined;
    let existing;
    try { existing = await client.send(new DescribeSecretCommand({ SecretId: requirement.name })); }
    catch (error) {
      if ((error as { name?: string }).name !== "ResourceNotFoundException") throw new Error(`Cannot inspect managed secret ${requirement.name}. Check Secrets Manager access.`);
    }
    let changed = value !== undefined;
    let version: string | undefined;
    let existingTags: DeclarationTags = {};
    if (existing) {
      if (existing.DeletedDate) throw new Error(`${requirement.name} is scheduled for deletion. Restore it before deploying.`);
      const tags = Object.fromEntries((existing.Tags ?? []).map(tag => [tag.Key, tag.Value]));
      existingTags = Object.fromEntries(Object.entries(tags).filter(([key, value]) => !/^(?:framework:|aws:)/i.test(key) && key !== "ManagedBy" && typeof value === "string")) as DeclarationTags;
      if (tags["framework:deployment"] !== requirement.deployment || tags["framework:resource"] !== requirement.path.join(".") || tags["framework:environment"] !== requirement.variable) throw new Error(`${requirement.name} is not owned by this deployment and resource declaration.`);
      assertArn(existing.ARN, identity, requirement.name);
      // An existing secret with no current value cannot satisfy a required consumer.
      let current;
      try { current = await client.send(new GetSecretValueCommand({ SecretId: existing.ARN, VersionStage: "AWSCURRENT" })); }
      catch { throw new Error(`Cannot read the current managed secret ${requirement.name}. Check Secrets Manager access and its current version.`); }
      if (current.SecretString === undefined && value === undefined) throw new Error(`${requirement.name} has no usable string value.`);
      changed = value !== undefined && current.SecretString !== value;
      version = current.VersionId;
    } else if (value === undefined) {
      throw new Error(`${requirement.variable} is required by the selected deployment. Supply it in cdk-app/.env.dev or cdk-app/.env.prod, or restore its existing managed secret.`);
    }
    plans.set(requirement.name, { requirement, value, arn: existing?.ARN, current: version, changed, tagChanged: !sameTags(existingTags, requirement.tags), existingTags });
  }
  const entries = [...plans.values()].map((plan): SecretPlanEntry => ({ name: plan.requirement.name, variable: plan.requirement.variable, action: actionOf(plan) }));
  const arns = Object.fromEntries([...plans.values()].flatMap(({ requirement, arn }) => (arn ? [[requirement.name, arn]] : [])));
  return {
    entries, arns,
    bind: (planId) => bindSecretPlan(plans, planId),
    mismatch: (reviewed) => secretPlanMismatch(plans, reviewed),
    createMissing: (onCreate = () => {}) => createMissingSecrets(plans, identity, client, onCreate),
    apply: async (onUpdate = () => {}, reviewed) => {
      if (reviewed) {
        const problem = secretPlanMismatch(plans, reviewed);
        if (problem) throw new Error(`${problem} Plan again. Nothing was changed.`);
      }
      return applySecretPlan(plans, requirements, identity, client, onUpdate);
    },
  };
}

/** Every read and ownership check completes before the first write. Values stay in memory. */
export async function synchronizeDeploymentSecrets(
  requirements: readonly SecretRequirement[], authored: Readonly<Record<string, string | undefined>>,
  identity: { account: string; region: string }, client: Pick<SecretsManagerClient, "send">,
  onUpdate: (name: string) => void = () => {},
): Promise<SecretDeploymentResult> {
  return (await planDeploymentSecrets(requirements, authored, identity, client)).apply(onUpdate);
}

const BINDING_CONTEXT = "framework:secret-binding:v1";
const digest = (key: Buffer, name: string, value: string) =>
  createHmac("sha256", key).update(BINDING_CONTEXT).update("\0").update(name).update("\0").update(value).digest("base64url");
const same = (a: unknown, b: string) => {
  if (typeof a !== "string") return false;
  const [left, right] = [Buffer.from(a), Buffer.from(b)];
  return left.length === right.length && timingSafeEqual(left, right);
};

function bindSecretPlan(plans: ReadonlyMap<string, Planned>, planId: string): SecretBinding {
  const key = randomBytes(32);
  const secrets: Record<string, BoundSecret> = {};
  for (const [name, plan] of plans) {
    secrets[name] = {
      action: actionOf(plan),
      ...(plan.arn ? { arn: plan.arn } : {}),
      ...(plan.current ? { current: plan.current } : {}),
      ...(Object.keys(plan.requirement.tags ?? {}).length || Object.keys(plan.existingTags).length ? { tags: JSON.stringify(validateTags(plan.requirement.tags)), currentTags: JSON.stringify(validateTags(plan.existingTags)) } : {}),
      ...(plan.value !== undefined ? { authored: digest(key, name, plan.value) } : {}),
    };
  }
  return { version: 1, planId, key: key.toString("base64"), secrets };
}

/**
 * The rule apply enforces: every secret has the action the review showed; one
 * that exists is the same secret (ARN); one to be updated still holds the version
 * the review compared against; and one to be created or updated has exactly the
 * authored value the review bound. Secrets Manager has no conditional write, so a
 * change landing between this check and the write itself is not detected.
 */
function secretPlanMismatch(plans: ReadonlyMap<string, Planned>, reviewed: ReviewedSecrets): string | undefined {
  if (!plans.size && !reviewed.entries.length) return undefined;
  const { binding } = reviewed;
  const key = binding?.version === 1 && typeof binding.key === "string" ? Buffer.from(binding.key, "base64") : undefined;
  if (!binding || !key || key.length !== 32 || typeof binding.secrets !== "object" || binding.secrets === null) {
    return "The review's secret binding is missing or unreadable, so the secret writes cannot be matched to it.";
  }
  const problems: string[] = [];
  const names = [...new Set([...reviewed.entries.map((entry) => entry.name), ...plans.keys()])].sort();
  for (const name of names) {
    const shown = reviewed.entries.find((entry) => entry.name === name);
    const bound = Object.hasOwn(binding.secrets, name) ? binding.secrets[name] : undefined;
    const now = plans.get(name);
    if (!now) { problems.push(`${name} is no longer part of this deployment`); continue; }
    if (!shown || !bound) { problems.push(`${name} was not part of the review`); continue; }
    const action = actionOf(now);
    if (shown.action !== bound.action) { problems.push(`${name} does not match its review record`); continue; }
    if (action !== shown.action) { problems.push(`${name} was reviewed as ${shown.action} but is now ${action}`); continue; }
    if ((bound.arn ?? "") !== (now.arn ?? "")) { problems.push(`${name} was replaced in Secrets Manager`); continue; }
    if (action === "update" && (!bound.current || !now.current || bound.current !== now.current)) problems.push(`${name} changed in Secrets Manager`);
    if ((bound.tags ?? "{}") !== JSON.stringify(validateTags(now.requirement.tags)) || (bound.currentTags ?? "{}") !== JSON.stringify(validateTags(now.existingTags))) problems.push(`tags of ${name} changed`);
    // A tag update keeps action="update" even when a reviewed value was removed.
    // Keep checking its binding rather than silently applying only the tags.
    if ((action === "create" || now.changed || (action === "update" && bound.authored !== undefined)) && (bound.authored === undefined || now.value === undefined || !same(bound.authored, digest(key, name, now.value)))) {
      problems.push(`the authored value of ${now.requirement.variable} (${name}) changed`);
    }
  }
  return problems.length ? `Secret changes no longer match the review: ${problems.join("; ")}.` : undefined;
}

async function createSecret(plan: Planned, identity: { account: string; region: string }, client: Pick<SecretsManagerClient, "send">, created: () => void): Promise<void> {
  const { requirement } = plan;
  const result = await client.send(new CreateSecretCommand({
    Name: requirement.name, SecretString: plan.value,
    Description: `Managed resource ${requirement.path.join(".")}; populated by npm run deploy:resources.`,
    Tags: [
      ...Object.entries(requirement.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
      { Key: "ManagedBy", Value: requirement.deployment },
      { Key: "framework:deployment", Value: requirement.deployment },
      { Key: "framework:resource", Value: requirement.path.join(".") },
      { Key: "framework:environment", Value: requirement.variable },
    ],
  }));
  // It exists from here on, whatever the ARN check below decides.
  created();
  assertArn(result.ARN, identity, requirement.name);
  plan.arn = result.ARN;
  plan.current = result.VersionId;
  plan.changed = false;
  plan.tagChanged = false;
  plan.existingTags = plan.requirement.tags ?? {};
}

async function createMissingSecrets(
  plans: Map<string, Planned>, identity: { account: string; region: string },
  client: Pick<SecretsManagerClient, "send">, onCreate: (name: string) => void,
): Promise<readonly string[]> {
  const created: string[] = [];
  for (const plan of plans.values()) {
    if (plan.arn) continue;
    try {
      await createSecret(plan, identity, client, () => { created.push(plan.requirement.name); onCreate(plan.requirement.name); });
    } catch {
      throw new Error(`Creating managed secret ${plan.requirement.name} failed. Secrets created before it: ${created.join(", ") || "none"}. No existing secret was written.`);
    }
  }
  return created;
}

async function applySecretPlan(
  plans: Map<string, Planned>,
  requirements: readonly SecretRequirement[], identity: { account: string; region: string },
  client: Pick<SecretsManagerClient, "send">, onUpdate: (name: string) => void,
): Promise<SecretDeploymentResult> {
  const updated: string[] = [];
  for (const plan of plans.values()) {
    const { requirement } = plan;
    const noteUpdate = () => { if (!updated.includes(requirement.name)) { updated.push(requirement.name); onUpdate(requirement.name); } };
    try {
      if (!plan.arn) {
        await createSecret(plan, identity, client, noteUpdate);
      } else if (plan.changed || plan.tagChanged) {
        if (plan.changed) { await client.send(new PutSecretValueCommand({ SecretId: plan.arn, SecretString: plan.value })); noteUpdate(); }
        if (plan.tagChanged) {
          const desired = requirement.tags ?? {};
          const remove = Object.keys(plan.existingTags).filter(key => !Object.hasOwn(desired, key));
          if (remove.length) { await client.send(new UntagResourceCommand({ SecretId: plan.arn, TagKeys: remove })); noteUpdate(); }
          if (Object.keys(desired).length) { await client.send(new TagResourceCommand({ SecretId: plan.arn, Tags: Object.entries(desired).map(([Key, Value]) => ({ Key, Value })) })); noteUpdate(); }
        }
      }
    } catch {
      throw new Error(`Secret synchronization failed for ${requirement.name}. Secret updates already performed: ${updated.join(", ") || "none"}. No infrastructure deployment was started.`);
    }
  }
  return { updated, parameters: requirements.map(requirement => `${requirement.stack}:${requirement.parameter}=${plans.get(requirement.name)!.arn}`) };
}

function assertArn(arn: string | undefined, identity: { account: string; region: string }, name: string): asserts arn is string {
  const match = /^arn:[^:]+:secretsmanager:([^:]+):(\d{12}):secret:.+-[A-Za-z0-9]{6}$/.exec(arn ?? "");
  if (!match || match[1] !== identity.region || match[2] !== identity.account) throw new Error(`Secrets Manager returned an invalid or mismatched complete ARN for ${name}.`);
}
