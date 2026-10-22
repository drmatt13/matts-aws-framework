import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { CreateSecretCommand, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand, UntagResourceCommand } from "@aws-sdk/client-secrets-manager";
import { planDeploymentSecrets, type SecretBinding, type SecretRequirement } from "../../scripts/deployment-secrets";

/**
 * A reviewed secret write is bound to exactly what the review saw: the authored
 * value (by a keyed digest made for that plan alone) and the AWS version it
 * replaces. Planning creates only what is missing. Everything runs against an
 * in-memory Secrets Manager; nothing reaches AWS.
 */

const identity = { account: "111122223333", region: "eu-west-2" };
const requirementFor = (variable: string): SecretRequirement => ({
  version: 1, path: [variable.toLowerCase()], variable, name: `example/secret/${variable}`, deployment: "example", mode: "prod", ...identity, stack: "App", parameter: `${variable}Arn`,
});
const KEY = requirementFor("KEY");
const OTHER = requirementFor("OTHER");
// Low-entropy on purpose: a digest without a private key would give these away.
const REVIEWED = "hunter2";
const EDITED = "hunter3";
const PREVIOUS = "old-value";

interface StoredSecret { arn: string; value: string; version: string; tags: { Key: string; Value: string }[] }

/** Secrets Manager in memory: versions change on every write, as in AWS. */
function secretsManager(seed: Record<string, string> = {}) {
  const secrets = new Map<string, StoredSecret>();
  const calls: { command: string; name: string }[] = [];
  const failures = new Map<string, number>();
  const ownedTags = (requirement: SecretRequirement) => [
    { Key: "framework:deployment", Value: requirement.deployment }, { Key: "framework:resource", Value: requirement.path.join(".") }, { Key: "framework:environment", Value: requirement.variable },
  ];
  const arnOf = (name: string) => `arn:aws:secretsmanager:${identity.region}:${identity.account}:secret:${name}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
  const put = (requirement: SecretRequirement, value: string) => secrets.set(requirement.name, { arn: arnOf(requirement.name), value, version: randomUUID(), tags: ownedTags(requirement) });
  for (const [variable, value] of Object.entries(seed)) put(requirementFor(variable), value);
  const find = (id: string) => [...secrets.entries()].find(([name, secret]) => name === id || secret.arn === id);
  const client = {
    send: async (command: any): Promise<any> => {
      const name = String(command.input.SecretId ?? command.input.Name);
      const kind = command.constructor.name;
      calls.push({ command: kind, name });
      const remaining = failures.get(kind);
      if (remaining !== undefined) {
        if (remaining <= 0) throw new Error(`simulated ${kind} failure carrying ${command.input.SecretString ?? "nothing"}`);
        failures.set(kind, remaining - 1);
      }
      const found = find(name);
      if (command instanceof DescribeSecretCommand) {
        if (!found) throw Object.assign(new Error("absent"), { name: "ResourceNotFoundException" });
        return { ARN: found[1].arn, Name: found[0], Tags: found[1].tags };
      }
      if (command instanceof GetSecretValueCommand) return { ARN: found![1].arn, SecretString: found![1].value, VersionId: found![1].version };
      if (command instanceof CreateSecretCommand) {
        if (found) throw Object.assign(new Error("exists"), { name: "ResourceExistsException" });
        const arn = arnOf(name);
        const version = randomUUID();
        secrets.set(name, { arn, value: command.input.SecretString ?? "", version, tags: (command.input.Tags ?? []).map((tag) => ({ Key: tag.Key ?? "", Value: tag.Value ?? "" })) });
        return { ARN: arn, VersionId: version };
      }
      if (command instanceof PutSecretValueCommand) {
        found![1].value = command.input.SecretString ?? "";
        found![1].version = randomUUID();
        return { ARN: found![1].arn, VersionId: found![1].version };
      }
      if (command instanceof TagResourceCommand) {
        const tags = new Map(found![1].tags.map(tag => [tag.Key, tag.Value]));
        for (const tag of command.input.Tags ?? []) tags.set(tag.Key!, tag.Value!);
        found![1].tags = [...tags].map(([Key, Value]) => ({ Key, Value }));
        return {};
      }
      if (command instanceof UntagResourceCommand) {
        found![1].tags = found![1].tags.filter(tag => !command.input.TagKeys?.includes(tag.Key));
        return {};
      }
      throw new Error(`unexpected ${kind}`);
    },
  };
  return {
    client, calls, secrets,
    /** Another writer changes a value in AWS. */
    write: (requirement: SecretRequirement, value: string) => { const secret = secrets.get(requirement.name)!; secret.value = value; secret.version = randomUUID(); },
    /** The secret is deleted and created again under the same name: a new ARN. */
    recreate: (requirement: SecretRequirement) => put(requirement, secrets.get(requirement.name)!.value),
    /** The (n+1)th call of a kind fails. */
    failAfter: (kind: string, successes: number) => failures.set(kind, successes),
    writes: () => calls.filter((call) => call.command === "CreateSecretCommand" || call.command === "PutSecretValueCommand" || call.command === "TagResourceCommand" || call.command === "UntagResourceCommand"),
  };
}

async function reviewed(aws: ReturnType<typeof secretsManager>, requirements: readonly SecretRequirement[], authored: Record<string, string>) {
  const plan = await planDeploymentSecrets(requirements, authored, identity, aws.client);
  return { entries: plan.entries, binding: plan.bind("plan-test-abcdef") };
}

test("an unchanged review applies exactly the reviewed writes", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  const review = await reviewed(aws, [KEY, OTHER], { KEY: REVIEWED, OTHER: REVIEWED });
  assert.deepEqual(review.entries.map((entry) => entry.action), ["update", "create"]);
  assert.deepEqual(aws.writes(), [], "reviewing writes nothing");

  const again = await planDeploymentSecrets([KEY, OTHER], { KEY: REVIEWED, OTHER: REVIEWED }, identity, aws.client);
  assert.equal(again.mismatch(review), undefined);
  const result = await again.apply(() => {}, review);
  assert.deepEqual(result.updated, [KEY.name, OTHER.name]);
  assert.equal(aws.secrets.get(KEY.name)!.value, REVIEWED);
  assert.equal(aws.secrets.get(OTHER.name)!.value, REVIEWED);
});

test("a reviewed value edited before apply is refused before any write, naming the variable but no value", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  const review = await reviewed(aws, [KEY], { KEY: REVIEWED });
  // Both values are updates: names and actions alone cannot tell them apart.
  const again = await planDeploymentSecrets([KEY], { KEY: EDITED }, identity, aws.client);
  assert.deepEqual(again.entries, review.entries);
  await assert.rejects(again.apply(() => {}, review), (error: Error) => {
    assert.match(error.message, /the authored value of KEY \(example\/secret\/KEY\) changed/);
    assert.match(error.message, /Plan again\. Nothing was changed\./);
    for (const value of [REVIEWED, EDITED, PREVIOUS]) assert.ok(!error.message.includes(value), `the error carries no value (${value})`);
    return true;
  });
  assert.deepEqual(aws.writes(), []);
  assert.equal(aws.secrets.get(KEY.name)!.value, PREVIOUS);

  // A value to be created is bound the same way.
  const fresh = secretsManager();
  const creation = await reviewed(fresh, [KEY], { KEY: REVIEWED });
  const edited = await planDeploymentSecrets([KEY], { KEY: EDITED }, identity, fresh.client);
  assert.match(String(edited.mismatch(creation)), /authored value of KEY/);
  await assert.rejects(edited.apply(() => {}, creation));
  assert.deepEqual(fresh.writes(), []);
});

test("a value written in Secrets Manager after the review is not overwritten", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  const review = await reviewed(aws, [KEY], { KEY: REVIEWED });
  aws.write(KEY, "someone-else");
  const again = await planDeploymentSecrets([KEY], { KEY: REVIEWED }, identity, aws.client);
  assert.deepEqual(again.entries.map((entry) => entry.action), ["update"], "still an update by name and action");
  await assert.rejects(again.apply(() => {}, review), /example\/secret\/KEY changed in Secrets Manager/);
  assert.deepEqual(aws.writes(), []);
  assert.equal(aws.secrets.get(KEY.name)!.value, "someone-else");
});

test("every other drift since the review refuses: a new action, a replaced secret, one created meanwhile", async () => {
  // unchanged then, update now
  const unchanged = secretsManager({ KEY: REVIEWED });
  const keep = await reviewed(unchanged, [KEY], { KEY: REVIEWED });
  assert.deepEqual(keep.entries.map((entry) => entry.action), ["unchanged"]);
  unchanged.write(KEY, "rotated");
  assert.match(String((await planDeploymentSecrets([KEY], { KEY: REVIEWED }, identity, unchanged.client)).mismatch(keep)), /reviewed as unchanged but is now update/);

  // the same value under a new ARN: change sets were prepared against the old one
  const replaced = secretsManager({ KEY: REVIEWED });
  const before = await reviewed(replaced, [KEY], {});
  replaced.recreate(KEY);
  assert.match(String((await planDeploymentSecrets([KEY], {}, identity, replaced.client)).mismatch(before)), /replaced in Secrets Manager/);

  // to be created then, created by someone else since
  const raced = secretsManager();
  const create = await reviewed(raced, [KEY], { KEY: REVIEWED });
  await (await planDeploymentSecrets([KEY], { KEY: REVIEWED }, identity, raced.client)).createMissing();
  assert.match(String((await planDeploymentSecrets([KEY], { KEY: REVIEWED }, identity, raced.client)).mismatch(create)), /reviewed as create but is now unchanged/);
});

test("a missing, unreadable or foreign binding refuses", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  const review = await reviewed(aws, [KEY], { KEY: REVIEWED });
  const again = await planDeploymentSecrets([KEY], { KEY: REVIEWED }, identity, aws.client);
  assert.match(String(again.mismatch({ entries: review.entries, binding: undefined })), /binding is missing or unreadable/);
  assert.match(String(again.mismatch({ entries: review.entries, binding: { ...review.binding, key: "c2hvcnQ=" } })), /binding is missing or unreadable/);
  // A digest only matches under the key it was made with: another plan's key does not verify this one.
  const other = (await planDeploymentSecrets([KEY], { KEY: REVIEWED }, identity, aws.client)).bind("plan-test-abcdef");
  assert.match(String(again.mismatch({ entries: review.entries, binding: { ...review.binding, key: other.key } })), /authored value of KEY/);
  // A tampered digest is refused, never thrown on: the same length in characters, not in bytes.
  const digest = review.binding.secrets[KEY.name]!.authored!;
  for (const authored of ["é".repeat(digest.length), 42 as unknown as string]) {
    assert.match(String(again.mismatch({ entries: review.entries, binding: { ...review.binding, secrets: { [KEY.name]: { ...review.binding.secrets[KEY.name]!, authored } } } })), /authored value of KEY/);
  }
  // A binding whose record disagrees with plan.json's action.
  const tampered: SecretBinding = { ...review.binding, secrets: { [KEY.name]: { ...review.binding.secrets[KEY.name]!, action: "unchanged" } } };
  assert.match(String(again.mismatch({ entries: review.entries, binding: tampered })), /does not match its review record/);
  // A secret the review never saw.
  assert.match(String((await planDeploymentSecrets([KEY, OTHER], { KEY: REVIEWED, OTHER: REVIEWED }, identity, aws.client)).mismatch(review)), /OTHER was not part of the review/);
  assert.deepEqual(aws.writes(), []);
});

test("a binding carries no value, and nothing that identifies a value without its per-plan key", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  const plan = await planDeploymentSecrets([KEY], { KEY: REVIEWED }, identity, aws.client);
  const first = plan.bind("plan-test-abcdef");
  const second = plan.bind("plan-test-abcdef");
  const text = JSON.stringify(first) + JSON.stringify(plan.entries) + JSON.stringify(plan.arns);
  const unkeyed = [
    REVIEWED, PREVIOUS,
    ...["hex", "base64", "base64url"].flatMap((encoding) => ["sha256", "sha1", "md5"].map((algorithm) => createHash(algorithm).update(REVIEWED).digest(encoding as "hex"))),
  ];
  for (const leak of unkeyed) assert.ok(!text.includes(leak), `no ${leak.length}-character value or unkeyed digest`);
  assert.notEqual(first.secrets[KEY.name]!.authored, second.secrets[KEY.name]!.authored, "the same value binds differently under each plan's key");
  assert.notEqual(first.key, second.key);
  assert.deepEqual(Object.keys(plan.entries[0]!).sort(), ["action", "name", "variable"], "entries plan.json shows hold names and actions only");
});

test("creating missing secrets never writes an existing one, and a mixed plan keeps its update for apply", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  const plan = await planDeploymentSecrets([KEY, OTHER], { KEY: REVIEWED, OTHER: REVIEWED }, identity, aws.client);
  assert.deepEqual(plan.entries.map((entry) => entry.action), ["update", "create"]);
  const created: string[] = [];
  assert.deepEqual(await plan.createMissing((name) => created.push(name)), [OTHER.name]);
  assert.deepEqual(created, [OTHER.name]);
  assert.deepEqual(aws.writes().map((call) => call.command), ["CreateSecretCommand"], "no PutSecretValue while preparing");
  assert.equal(aws.secrets.get(KEY.name)!.value, PREVIOUS, "the existing secret still holds its value");

  // The review is made of what AWS holds after creation; the update waits for apply.
  const review = await reviewed(aws, [KEY, OTHER], { KEY: REVIEWED, OTHER: REVIEWED });
  assert.deepEqual(review.entries.map((entry) => entry.action), ["update", "unchanged"]);
  const result = await (await planDeploymentSecrets([KEY, OTHER], { KEY: REVIEWED, OTHER: REVIEWED }, identity, aws.client)).apply(() => {}, review);
  assert.deepEqual(result.updated, [KEY.name]);
  assert.deepEqual(aws.writes().map((call) => call.command), ["CreateSecretCommand", "PutSecretValueCommand"]);
});

test("creation that fails part-way says what it created, writes nothing else, and leaks no value", async () => {
  const third = requirementFor("THIRD");
  const aws = secretsManager({ KEY: PREVIOUS });
  aws.failAfter("CreateSecretCommand", 1);
  const plan = await planDeploymentSecrets([KEY, OTHER, third], { KEY: REVIEWED, OTHER: REVIEWED, THIRD: REVIEWED }, identity, aws.client);
  await assert.rejects(plan.createMissing(), (error: Error) => {
    assert.match(error.message, /Creating managed secret example\/secret\/THIRD failed\. Secrets created before it: example\/secret\/OTHER\. No existing secret was written\./);
    assert.ok(!error.message.includes(REVIEWED));
    return true;
  });
  assert.deepEqual(aws.writes().map((call) => [call.command, call.name]), [["CreateSecretCommand", OTHER.name], ["CreateSecretCommand", third.name]]);
  assert.equal(aws.secrets.has(third.name), false);
  assert.equal(aws.secrets.get(KEY.name)!.value, PREVIOUS);
});

test("a reviewed apply that fails part-way reports only the writes that happened", async () => {
  const aws = secretsManager({ KEY: PREVIOUS, OTHER: PREVIOUS });
  const review = await reviewed(aws, [KEY, OTHER], { KEY: REVIEWED, OTHER: REVIEWED });
  aws.failAfter("PutSecretValueCommand", 1);
  const updated: string[] = [];
  const again = await planDeploymentSecrets([KEY, OTHER], { KEY: REVIEWED, OTHER: REVIEWED }, identity, aws.client);
  await assert.rejects(again.apply((name) => updated.push(name), review), (error: Error) => {
    assert.match(error.message, /Secret synchronization failed for example\/secret\/OTHER\. Secret updates already performed: example\/secret\/KEY\. No infrastructure deployment was started\./);
    assert.ok(!error.message.includes(REVIEWED) && !error.message.includes(PREVIOUS));
    return true;
  });
  assert.deepEqual(updated, [KEY.name], "only the write that succeeded is reported");
  assert.equal(aws.secrets.get(OTHER.name)!.value, PREVIOUS);
  // What is left cannot be applied again under the old review: KEY no longer needs its update.
  const after = await planDeploymentSecrets([KEY, OTHER], { KEY: REVIEWED, OTHER: REVIEWED }, identity, aws.client);
  assert.match(String(after.mismatch(review)), /KEY was reviewed as update but is now unchanged/);
});


test("reviewed secret metadata updates and removals preserve ownership and do not rewrite its value", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  aws.secrets.get(KEY.name)!.tags.push({ Key: "area", Value: "old" }, { Key: "obsolete", Value: "remove" });
  const requirement = { ...KEY, tags: { area: "billing" } };
  const plan = await planDeploymentSecrets([requirement], {}, identity, aws.client);
  const review = { entries: plan.entries, binding: plan.bind("plan-tags") };
  assert.deepEqual(plan.entries.map(entry => entry.action), ["update"]);
  assert.deepEqual(aws.writes(), []);
  await plan.apply(() => {}, review);
  const stored = aws.secrets.get(KEY.name)!;
  assert.equal(stored.value, PREVIOUS);
  assert.deepEqual(Object.fromEntries(stored.tags.map(tag => [tag.Key, tag.Value])), {
    "framework:deployment": KEY.deployment, "framework:resource": "key", "framework:environment": "KEY", area: "billing",
  });
  assert.deepEqual(aws.writes().map(call => call.command), ["UntagResourceCommand", "TagResourceCommand"]);
  const remove = await planDeploymentSecrets([KEY], {}, identity, aws.client);
  await remove.apply();
  assert.equal(stored.tags.some(tag => tag.Key === "area"), false);
});

test("secret tag drift invalidates the bound review before any write", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  const requirement = { ...KEY, tags: { area: "billing" } };
  const review = await reviewed(aws, [requirement], {});
  const changedSource = await planDeploymentSecrets([{ ...requirement, tags: { area: "other" } }], {}, identity, aws.client);
  assert.match(String(changedSource.mismatch(review)), /tags of .* changed/);
  aws.secrets.get(KEY.name)!.tags.push({ Key: "area", Value: "external" });
  const changedAws = await planDeploymentSecrets([requirement], {}, identity, aws.client);
  await assert.rejects(changedAws.apply(() => {}, review), /tags of .* changed/);
  assert.deepEqual(aws.writes(), []);
});

test("removing a reviewed value update cannot turn a combined update into tags only", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  const requirement = { ...KEY, tags: { area: "billing" } };
  const review = await reviewed(aws, [requirement], { KEY: REVIEWED });
  const again = await planDeploymentSecrets([requirement], {}, identity, aws.client);
  assert.deepEqual(again.entries, review.entries, "both plans still advertise an update");
  await assert.rejects(again.apply(() => {}, review), /the authored value of KEY .* changed/);
  assert.deepEqual(aws.writes(), [], "drift refuses before writing values or tags");
  assert.equal(aws.secrets.get(KEY.name)!.value, PREVIOUS);
});


test("a tag failure after a value write reports that secret as already changed", async () => {
  const aws = secretsManager({ KEY: PREVIOUS });
  aws.failAfter("TagResourceCommand", 0);
  const plan = await planDeploymentSecrets([{ ...KEY, tags: { area: "billing" } }], { KEY: REVIEWED }, identity, aws.client);
  await assert.rejects(plan.apply(), /Secret updates already performed: example\/secret\/KEY/);
  assert.equal(aws.secrets.get(KEY.name)!.value, REVIEWED);
});
