#!/usr/bin/env node
/**
 * A simulated AWS CLI for tests: FRAMEWORK_AWS_CLI points the deployment
 * scripts here, and FAKE_AWS_STATE names a JSON file holding the account.
 *
 * Every call is appended to state.calls. Unless state.allowWrites is true, any
 * verb that is not a read fails, which is how tests prove a command only
 * observes. state.failures maps "<service> <operation>" to an error kind
 * (expired, denied, no-credentials, profile, not-found) to simulate failures.
 */
import { readFileSync, writeFileSync } from "node:fs";

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
  if (next === undefined || next.startsWith("--")) options[arg.slice(2)] = true;
  else { options[arg.slice(2)] = options[arg.slice(2)] === undefined ? next : [].concat(options[arg.slice(2)], next); index++; }
}
const key = `${service} ${operation}`;
state.calls = [...(state.calls ?? []), { key, options }];
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
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
  save();
  process.stderr.write(`${message ?? STDERR[kind] ?? kind}\n`);
  process.exit(254);
}
const reply = (value) => { save(); process.stdout.write(JSON.stringify(value)); process.exit(0); };

if (state.failures?.[key]) fail(state.failures[key]);
const read = /^(get-|describe-|list-)/.test(operation ?? "") || key === "sts get-caller-identity";
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
  case "cloudformation list-change-sets": {
    const stack = requireStack();
    reply({ Summaries: (stack.ChangeSets ?? []).map(({ Changes, ...summary }) => summary) });
  }
  case "cloudformation describe-change-set": {
    const stack = requireStack();
    const set = (stack.ChangeSets ?? []).find((entry) => entry.ChangeSetName === options["change-set-name"] || entry.ChangeSetId === options["change-set-name"]);
    if (!set) fail("not-found");
    reply(set);
  }
  case "cloudformation list-imports":
    reply({ Imports: (account.imports ?? {})[options["export-name"]] ?? [] });
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
  case "secretsmanager list-secrets":
    reply({ SecretList: (account.secrets ?? []).map(({ SecretString, ...secret }) => secret) });
  case "secretsmanager describe-secret": {
    const secret = (account.secrets ?? []).find((entry) => entry.Name === options["secret-id"] || entry.ARN === options["secret-id"]);
    if (!secret) fail("not-found", "An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: Secrets Manager can't find the specified secret.");
    const { SecretString, ...described } = secret;
    reply(described);
  }
  case "secretsmanager get-secret-value": {
    const secret = (account.secrets ?? []).find((entry) => entry.Name === options["secret-id"] || entry.ARN === options["secret-id"]);
    if (!secret) fail("not-found", "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret.");
    reply({ ARN: secret.ARN, Name: secret.Name, SecretString: secret.SecretString });
  }
  case "secretsmanager create-secret": {
    const arnOf = `arn:aws:secretsmanager:${region}:${state.identity?.Account ?? "111122223333"}:secret:${options.name}-AbCdEf`;
    account.secrets = [...(account.secrets ?? []), { Name: options.name, ARN: arnOf, SecretString: options["secret-string"], Tags: [] }];
    reply({ ARN: arnOf, Name: options.name });
  }
  case "secretsmanager put-secret-value": {
    const secret = (account.secrets ?? []).find((entry) => entry.Name === options["secret-id"] || entry.ARN === options["secret-id"]);
    if (!secret) fail("not-found");
    secret.SecretString = options["secret-string"];
    reply({ ARN: secret.ARN });
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
