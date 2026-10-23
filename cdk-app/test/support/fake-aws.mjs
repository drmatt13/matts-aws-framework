#!/usr/bin/env node
/**
 * A simulated AWS CLI for tests: FRAMEWORK_AWS_CLI points the deployment
 * scripts here, and FAKE_AWS_STATE names a JSON file holding the account.
 *
 * Every call is appended to <state>.calls.jsonl. Unless state.allowWrites is true, any
 * verb that is not a read fails, which is how tests prove a command only
 * observes. state.failures maps "<service> <operation>" to an error kind
 * (expired, denied, no-credentials, profile, not-found) to simulate failures.
 *
 * A read never writes the state file, and a write replaces it whole: the
 * scripts run several of these at once (a watch beside a deployment).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Replaces the state file whole, so a concurrent reader never sees half of it. */
function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, file); return; } catch (error) {
      if (attempt > 100 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}


const statePath = process.env.FAKE_AWS_STATE;
if (!statePath) { process.stderr.write("FAKE_AWS_STATE is not set\n"); process.exit(2); }
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const [service, operation] = args;
const options = {};
for (let index = 2; index < args.length; index++) {
  const arg = args[index];
  if (!arg.startsWith("--")) continue;
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) { options[arg.slice(2)] = true; continue; }
  // An option may take several values (--filters a b, --stack-resource-drift-status-filters X Y).
  const values = [];
  while (args[index + 1] !== undefined && !args[index + 1].startsWith("--")) values.push(args[++index]);
  const previous = options[arg.slice(2)];
  options[arg.slice(2)] = previous === undefined && values.length === 1 ? values[0] : [].concat(previous ?? [], values);
}
const key = `${service} ${operation}`;
appendFileSync(`${statePath}.calls.jsonl`, `${JSON.stringify({ key, options })}\n`);
const read = /^(get-|describe-|list-)/.test(operation ?? "") || key === "sts get-caller-identity";
const save = () => { if (!read) writeAtomic(statePath, JSON.stringify(state, null, 2)); };
const region = options.region ?? state.defaultRegion ?? "us-east-1";
const account = (state.regions ??= {})[region] ??= {};
account.stacks ??= [];

const STDERR = {
  expired: "Error when retrieving token from sso: Token has expired and refresh failed",
  denied: `An error occurred (AccessDenied) when calling the ${operation} operation: User is not authorized to perform this action`,
  "no-credentials": "Unable to locate credentials. You can configure credentials by running \"aws configure\".",
  profile: `The config profile (${options.profile ?? "default"}) could not be found`,
  "not-found": `An error occurred (ValidationError) when calling the ${operation} operation: Stack with id ${options["stack-name"] ?? "x"} does not exist`,
};
function fail(kind, message) {
  process.stderr.write(`${message ?? STDERR[kind] ?? kind}\n`);
  process.exit(254);
}
const reply = (value) => { save(); process.stdout.write(JSON.stringify(value)); process.exit(0); };

if (state.failures?.[key]) fail(state.failures[key]);
if (!read && !state.allowWrites) fail("write", `fake-aws: refused write ${key} (the test allows reads only)`);

const live = () => account.stacks.filter((stack) => stack.StackStatus !== "DELETE_COMPLETE");
const byName = (name) => live().find((stack) => stack.StackName === name || stack.StackId === name);
const describe = ({ Template, Events, ChangeSets, Resources, ...stack }) => stack;
const requireStack = () => byName(options["stack-name"]) ?? fail("not-found");

switch (key) {
  case "sts get-caller-identity":
    reply(state.identity ?? { Account: "111122223333", Arn: "arn:aws:sts::111122223333:assumed-role/Dev/test", UserId: "AIDTEST" });
  case "cloudformation describe-stacks": {
    if (options["stack-name"]) reply({ Stacks: [describe(requireStack())] });
    const all = live().map(describe);
    const size = state.pageSize ?? 100;
    const start = options["next-token"] ? Number(options["next-token"]) : 0;
    const page = all.slice(start, start + size);
    reply({ Stacks: page, ...(start + size < all.length ? { NextToken: String(start + size) } : {}) });
  }
  case "cloudformation get-template": {
    const stack = requireStack();
    reply({ TemplateBody: stack.Template ?? {}, StagesAvailable: ["Original", "Processed"] });
  }
  case "cloudformation get-template-summary": {
    const stack = requireStack();
    const metadata = stack.Template?.Metadata;
    reply({ Parameters: [], ...(metadata ? { Metadata: JSON.stringify(metadata) } : {}) });
  }
  case "cloudformation describe-stack-events": {
    const stack = requireStack();
    reply({ StackEvents: [...(stack.Events ?? [])] });
  }
  case "cloudformation list-stack-resources": {
    const stack = requireStack();
    reply({ StackResourceSummaries: stack.Resources ?? [...new Map([...(stack.Events ?? [])].reverse().map(event => [event.LogicalResourceId, event])).values()] });
  }
  case "cloudformation list-change-sets": {
    const stack = requireStack();
    reply({ Summaries: (stack.ChangeSets ?? []).map(({ Changes, ...summary }) => summary) });
  }
  case "cloudformation describe-change-set": {
    const stack = requireStack();
    const set = (stack.ChangeSets ?? []).find((entry) => entry.ChangeSetName === options["change-set-name"] || entry.ChangeSetId === options["change-set-name"]);
    if (!set) fail("not-found");
    reply({ ...set, StackId: stack.StackId });
  }
  case "cloudformation list-imports":
    reply({ Imports: ((account.imports ?? {})[options["export-name"]] ?? []).filter((name) => !account.stacks.some((stack) => stack.StackName === name && stack.StackStatus === "DELETE_COMPLETE")) });
  case "cloudformation list-exports":
    reply({ Exports: account.exports ?? [] });
  case "cloudformation describe-stack-resources": {
    const stack = requireStack();
    reply({ StackResources: stack.Resources ?? [] });
  }
  case "ssm get-parameters-by-path": {
    const path = options.path ?? "/";
    reply({ Parameters: (account.parameters ?? []).filter((parameter) => parameter.Name.startsWith(path)) });
  }
  case "secretsmanager list-secrets": {
    // --filters Key=tag-key,Values=... Key=tag-value,Values=...: every filter must match, as in AWS.
    const filters = [].concat(options.filters ?? []).map((filter) => Object.fromEntries(String(filter).split(",").map((pair) => pair.split("="))));
    const matches = (secret) => filters.every(({ Key, Values }) =>
      Key === "tag-key" ? (secret.Tags ?? []).some((tag) => tag.Key === Values)
        : Key === "tag-value" ? (secret.Tags ?? []).some((tag) => tag.Value === Values)
          : Key === "name" ? secret.Name.startsWith(Values) : true);
    reply({ SecretList: (account.secrets ?? []).filter(matches).map(({ SecretString, ...secret }) => secret) });
  }
  case "secretsmanager describe-secret": {
    const secret = (account.secrets ?? []).find((entry) => entry.Name === options["secret-id"] || entry.ARN === options["secret-id"]);
    if (!secret) fail("not-found", "An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: Secrets Manager can't find the specified secret.");
    const { SecretString, ...described } = secret;
    reply(described);
  }
  case "secretsmanager get-secret-value": {
    const secret = (account.secrets ?? []).find((entry) => entry.Name === options["secret-id"] || entry.ARN === options["secret-id"]);
    if (!secret) fail("not-found", "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret.");
    reply({ ARN: secret.ARN, Name: secret.Name, SecretString: secret.SecretString, VersionId: secret.VersionId, VersionStages: ["AWSCURRENT"] });
  }
  case "secretsmanager create-secret": {
    // As in AWS: creating a name that exists fails, and every value is a new AWSCURRENT version.
    if ((account.secrets ?? []).some((entry) => entry.Name === options.name)) fail("exists", "An error occurred (ResourceExistsException) when calling the CreateSecret operation: The operation failed because the secret already exists.");
    const arnOf = `arn:aws:secretsmanager:${region}:${state.identity?.Account ?? "111122223333"}:secret:${options.name}-AbCdEf`;
    const VersionId = randomUUID();
    account.secrets = [...(account.secrets ?? []), { Name: options.name, ARN: arnOf, SecretString: options["secret-string"], VersionId, Tags: options.tags ? JSON.parse(options.tags) : [] }];
    reply({ ARN: arnOf, Name: options.name, VersionId });
  }
  case "secretsmanager put-secret-value": {
    const secret = (account.secrets ?? []).find((entry) => entry.Name === options["secret-id"] || entry.ARN === options["secret-id"]);
    if (!secret) fail("not-found");
    secret.SecretString = options["secret-string"];
    secret.VersionId = randomUUID();
    reply({ ARN: secret.ARN, VersionId: secret.VersionId, VersionStages: ["AWSCURRENT"] });
  }
  case "secretsmanager tag-resource": {
    const secret = (account.secrets ?? []).find((entry) => entry.Name === options["secret-id"] || entry.ARN === options["secret-id"]);
    if (!secret) fail("not-found");
    const tags = new Map((secret.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    for (const tag of JSON.parse(options.tags ?? "[]")) tags.set(tag.Key, tag.Value);
    secret.Tags = [...tags].map(([Key, Value]) => ({ Key, Value }));
    reply({});
  }
  case "secretsmanager untag-resource": {
    const secret = (account.secrets ?? []).find((entry) => entry.Name === options["secret-id"] || entry.ARN === options["secret-id"]);
    if (!secret) fail("not-found");
    const keys = [].concat(options["tag-keys"] ?? []);
    secret.Tags = (secret.Tags ?? []).filter(tag => !keys.includes(tag.Key));
    reply({});
  }
  case "resourcegroupstaggingapi get-resources":
    reply({ ResourceTagMappingList: account.taggedResources ?? [] });
  case "cloudformation delete-stack": {
    const stack = requireStack();
    if (stack.EnableTerminationProtection) fail("protected", `An error occurred (ValidationError) when calling the DeleteStack operation: Stack [${stack.StackName}] cannot be deleted while TerminationProtection is enabled`);
    stack.StackStatus = stack.failDelete ? "DELETE_FAILED" : "DELETE_COMPLETE";
    reply({});
  }
  case "cloudformation update-termination-protection": {
    const stack = requireStack();
    stack.EnableTerminationProtection = options["enable-termination-protection"] === true;
    reply({ StackId: stack.StackId });
  }
  case "cloudformation delete-change-set": {
    const stack = requireStack();
    stack.ChangeSets = (stack.ChangeSets ?? []).filter((entry) => entry.ChangeSetName !== options["change-set-name"] && entry.ChangeSetId !== options["change-set-name"]);
    reply({});
  }
  case "ssm put-parameter": {
    account.parameters = [...(account.parameters ?? []).filter((parameter) => parameter.Name !== options.name), { Name: options.name, Value: options.value, Type: "String" }];
    reply({ Version: 1 });
  }
  case "ssm add-tags-to-resource":
    reply({});
  case "ssm delete-parameter":
    account.parameters = (account.parameters ?? []).filter((parameter) => parameter.Name !== options.name);
    reply({});
  default:
    fail("unsupported", `fake-aws: ${key} is not simulated`);
}
