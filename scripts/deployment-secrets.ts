import { CreateSecretCommand, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface SecretRequirement {
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

/** Every read and ownership check completes before the first write. Values stay in memory. */
export async function synchronizeDeploymentSecrets(
  requirements: readonly SecretRequirement[], authored: Readonly<Record<string, string | undefined>>,
  identity: { account: string; region: string }, client: Pick<SecretsManagerClient, "send">,
  onUpdate: (name: string) => void = () => {},
): Promise<SecretDeploymentResult> {
  const plans = new Map<string, { requirement: SecretRequirement; value?: string; arn?: string; changed: boolean }>();
  for (const requirement of requirements) {
    if (requirement.account !== identity.account || requirement.region !== identity.region) throw new Error("Selected AWS credentials/account or region do not match the synthesized secret requirements.");
    const previous = plans.get(requirement.name);
    if (previous) {
      if (previous.requirement.variable !== requirement.variable || previous.requirement.deployment !== requirement.deployment || previous.requirement.path.join(".") !== requirement.path.join(".")) throw new Error(`Conflicting secret declarations for ${requirement.name}.`);
      continue;
    }
    const value = authored[requirement.variable] || undefined;
    let existing;
    try { existing = await client.send(new DescribeSecretCommand({ SecretId: requirement.name })); }
    catch (error) {
      if ((error as { name?: string }).name !== "ResourceNotFoundException") throw new Error(`Cannot inspect managed secret ${requirement.name}. Check Secrets Manager access.`);
    }
    let changed = value !== undefined;
    if (existing) {
      if (existing.DeletedDate) throw new Error(`${requirement.name} is scheduled for deletion. Restore it before deploying.`);
      const tags = Object.fromEntries((existing.Tags ?? []).map(tag => [tag.Key, tag.Value]));
      if (tags["framework:deployment"] !== requirement.deployment || tags["framework:resource"] !== requirement.path.join(".") || tags["framework:environment"] !== requirement.variable) throw new Error(`${requirement.name} is not owned by this deployment and resource declaration.`);
      assertArn(existing.ARN, identity, requirement.name);
      // An existing secret with no current value cannot satisfy a required consumer.
      let current;
      try { current = await client.send(new GetSecretValueCommand({ SecretId: existing.ARN, VersionStage: "AWSCURRENT" })); }
      catch { throw new Error(`Cannot read the current managed secret ${requirement.name}. Check Secrets Manager access and its current version.`); }
      if (current.SecretString === undefined && value === undefined) throw new Error(`${requirement.name} has no usable string value.`);
      changed = value !== undefined && current.SecretString !== value;
    } else if (value === undefined) {
      throw new Error(`${requirement.variable} is required by the selected deployment. Supply it in cdk-app/.env or restore its existing managed secret.`);
    }
    plans.set(requirement.name, { requirement, value, arn: existing?.ARN, changed });
  }
  const updated: string[] = [];
  for (const plan of plans.values()) {
    const { requirement } = plan;
    try {
      if (!plan.arn) {
        const created = await client.send(new CreateSecretCommand({
          Name: requirement.name, SecretString: plan.value,
          Description: `Managed resource ${requirement.path.join(".")}; populated by npm run deploy.`,
          Tags: [
            { Key: "ManagedBy", Value: requirement.deployment },
            { Key: "framework:deployment", Value: requirement.deployment },
            { Key: "framework:resource", Value: requirement.path.join(".") },
            { Key: "framework:environment", Value: requirement.variable },
          ],
        }));
        updated.push(requirement.name); onUpdate(requirement.name);
        assertArn(created.ARN, identity, requirement.name);
        plan.arn = created.ARN;
      } else if (plan.changed) {
        await client.send(new PutSecretValueCommand({ SecretId: plan.arn, SecretString: plan.value }));
        updated.push(requirement.name); onUpdate(requirement.name);
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
