import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Builds the JSON account fake-aws.mjs serves, and reads back the calls it saw. */

export const FAKE_AWS = path.join(__dirname, "fake-aws.mjs");
export const ACCOUNT = "734849394764";
export const REGION = "us-east-1";

export interface FakeStack {
  StackName: string;
  StackId: string;
  StackStatus: string;
  CreationTime?: string;
  LastUpdatedTime?: string;
  StackStatusReason?: string;
  Outputs?: { OutputKey?: string; OutputValue?: string; Description?: string; ExportName?: string }[];
  Tags?: { Key: string; Value: string }[];
  EnableTerminationProtection?: boolean;
  Template?: unknown;
  Events?: unknown[];
  ChangeSets?: unknown[];
  Resources?: unknown[];
  failDelete?: boolean;
}

export function frameworkStack(deployment: string, role: string, mode: "dev" | "prod", options: { contract?: 1 | 2; status?: string; outputs?: FakeStack["Outputs"]; template?: Record<string, unknown> } = {}): FakeStack {
  const name = `${deployment}-${role}`;
  const identity = { deployment, mode, account: ACCOUNT, region: REGION };
  const marker = { OutputKey: "FrameworkDeployment", Description: "framework:deployment:v1", OutputValue: JSON.stringify({ version: 1, ...identity }) };
  const contract = options.contract ?? 2;
  return {
    StackName: name,
    StackId: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/${Buffer.from(name).toString("hex").slice(0, 12)}`,
    StackStatus: options.status ?? "UPDATE_COMPLETE",
    CreationTime: "2026-10-12T15:00:00.000Z",
    LastUpdatedTime: "2026-10-12T15:10:00.000Z",
    Outputs: [marker, ...(options.outputs ?? [])],
    ...(contract === 2 ? { Tags: [
      { Key: "framework:owner", Value: "matts-aws-framework" }, { Key: "framework:deployment", Value: deployment },
      { Key: "framework:mode", Value: mode }, { Key: "framework:contract", Value: "2" },
    ] } : {}),
    Template: { Resources: {}, Outputs: { FrameworkDeployment: { Description: marker.Description, Value: marker.OutputValue } }, ...(contract === 2 ? { Metadata: { "framework:deployment": { contract: 2, owner: "matts-aws-framework", ...identity, stack: role } } } : {}), ...options.template },
    Events: [{ EventId: `${name}-1`, Timestamp: "2026-10-12T15:10:00.000Z", LogicalResourceId: name, ResourceType: "AWS::CloudFormation::Stack", ResourceStatus: options.status ?? "UPDATE_COMPLETE" }],
  };
}

export interface FakeAccount {
  readonly directory: string;
  readonly statePath: string;
  readonly env: NodeJS.ProcessEnv;
  read(): any;
  write(state: any): void;
  calls(): { key: string; options: Record<string, unknown> }[];
  dispose(): void;
}

export function fakeAccount(state: Record<string, unknown>): FakeAccount {
  const scratch = path.resolve(__dirname, "../../../.cache");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "fake-aws-"));
  const statePath = path.join(directory, "state.json");
  writeFileSync(statePath, JSON.stringify({ identity: { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Dev/tester`, UserId: "AIDTEST" }, ...state }, null, 2));
  const inputs = path.join(directory, "dev.env");
  writeFileSync(inputs, "CDK_APP_NAME=my-aws-app\n");
  const config = path.join(directory, "config");
  writeFileSync(config, `[profile dev]\nregion = ${REGION}\nsso_session = corp\n[sso-session corp]\nsso_start_url = https://example.awsapps.com/start\n`);
  const credentials = path.join(directory, "credentials");
  writeFileSync(credentials, "[default]\naws_access_key_id = AKIASENTINELNEVERPRINT\naws_secret_access_key = sentinel-secret-never-print\nregion = eu-west-2\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FRAMEWORK_AWS_CLI: FAKE_AWS,
    FAKE_AWS_STATE: statePath,
    FRAMEWORK_INPUTS_FILE: inputs,
    AWS_CONFIG_FILE: config,
    AWS_SHARED_CREDENTIALS_FILE: credentials,
  };
  delete env.AWS_PROFILE;
  delete env.AWS_REGION;
  delete env.AWS_DEFAULT_REGION;
  return {
    directory, statePath, env,
    read: () => JSON.parse(readFileSync(statePath, "utf8")),
    write: (next) => writeFileSync(statePath, JSON.stringify(next, null, 2)),
    calls: () => JSON.parse(readFileSync(statePath, "utf8")).calls ?? [],
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export const READ_VERB = /^(sts get-caller-identity|\S+ (get-|describe-|list-))/;
