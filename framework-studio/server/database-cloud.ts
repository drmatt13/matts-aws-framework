import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { identityFromOutputs, type ObservedStack } from "@repo/framework/deploy";
import { repositoryTargets } from "@repo/framework/deploy/node";
import { parseInvocationDescriptor, type AwsTaskDescriptor } from "../../packages/framework/src/runtime/descriptor";
import { buildTaskOverrides } from "../../packages/framework/src/runtime/aws";
import { DATABASE_REVIEW_PROTOCOL, databaseInputsDigest, decodeDatabaseEnvelope, digest, type DatabaseCloudEnvelope, type DatabaseCloudIdentity, type DatabaseCloudRequest } from "../../packages/database/scripts/studio-migrations";
import type { DatabaseCloudApproval, DatabaseCloudDestination } from "../shared/database-cloud";
import type { DatabaseApplicationResult, DatabaseOperationRecord } from "../shared/database-application";
import { EditError } from "./edits/io";
import { DatabaseOperationStore } from "./database-operations";
import { runCommand, studioEnvironment, Tools, type Runner } from "./deploy/process";

interface Destination { identity: DatabaseCloudIdentity; profile: string; descriptor: AwsTaskDescriptor; logGroup: string; streamPrefix: string }
const destinationBinding = (destination: Destination) => digest({ identity: destination.identity, descriptor: destination.descriptor, logGroup: destination.logGroup, streamPrefix: destination.streamPrefix });

/** Operator adapter to the declared VPC task with private-database IAM/TLS access. Preparation/application are
 * explicit billed task launches; no ingress, credentials or alternate DB path.
 */
export class DatabaseCloudService {
  private readonly approvals = new Map<string, DatabaseCloudApproval>();
  private readonly preparations = new Map<string, DatabaseCloudDestination>();
  private readonly tools: Tools;
  private readonly store: DatabaseOperationStore;
  constructor(private readonly root: string, private readonly run: Runner = runCommand, private readonly env: NodeJS.ProcessEnv = process.env) { this.tools = new Tools(root, env); this.store = new DatabaseOperationStore(root); }

  private async aws(profile: string, region: string, args: string[], timeoutMs = 30_000): Promise<any> {
    const response = await this.run(this.tools.aws([...args, "--profile", profile, "--region", region, "--output", "json"], studioEnvironment(this.env, { profile })), { timeoutMs });
    if (response.code !== 0) throw new EditError(422, "The selected AWS operation could not be confirmed. Check profile permissions/session and the recorded task before retrying; private CLI errors were omitted.");
    try { return JSON.parse(response.stdout); } catch { throw new EditError(422, "AWS returned an incomplete structured result. Inspect the recorded task before retrying."); }
  }

  private async destination(deployment: string, profile: string): Promise<Destination> {
    if (!profile.trim() || profile.length > 200 || /[\r\n\0]/.test(profile)) throw new EditError(400, "Choose a configured AWS profile.");
    const target = repositoryTargets(this.root, this.env).find(target => target.name === deployment && target.mode === "prod");
    if (!target?.account || !target.region) throw new EditError(422, "Production database operations require a named production target with a pinned account and region.");
    const caller = await this.aws(profile, target.region, ["sts", "get-caller-identity"]);
    if (caller.Account !== target.account) throw new EditError(409, "The profile account differs from this production deployment. No database task was started.");
    const stack = (await this.aws(profile, target.region, ["cloudformation", "describe-stacks", "--stack-name", `${deployment}-EcsTasksStack`])).Stacks?.[0] as ObservedStack | undefined;
    const owner = stack && identityFromOutputs(stack);
    if (!owner || owner.deployment !== deployment || owner.mode !== "prod" || owner.account !== target.account || owner.region !== target.region || !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack!.StackStatus ?? "")) throw new EditError(409, "The deployed tasks stack identity or state is not a stable match for this production target.");
    const raw = stack!.Outputs?.find(output => output.Description === "framework:task-launch:v1:db-migrate")?.OutputValue;
    if (!raw) throw new EditError(422, "This deployment has no declared db-migrate task descriptor. Deploy the reviewed task source separately before using production database review.");
    const descriptor = parseInvocationDescriptor(raw, { kind: "task", target: "db-migrate" }) as AwsTaskDescriptor;
    if (descriptor.transport !== "aws" || descriptor.launch.region !== target.region || descriptor.launch.cluster.split(":")[4] !== target.account) throw new EditError(409, "The declared migration task descriptor has a different AWS destination.");
    const resources = (await this.aws(profile, target.region, ["cloudformation", "list-stack-resources", "--stack-name", `${deployment}-EcsTasksStack`])).StackResourceSummaries ?? [];
    const definitions = resources.filter((resource: any) => resource.ResourceType === "AWS::ECS::TaskDefinition" && typeof resource.PhysicalResourceId === "string" && resource.PhysicalResourceId.split("/").at(-1)?.split(":")[0] === descriptor.launch.taskDefinitionFamily);
    if (definitions.length !== 1) throw new EditError(409, "The deployed tasks stack does not own exactly one migration task definition matching its launch descriptor. No task was started.");
    const definition = (await this.aws(profile, target.region, ["ecs", "describe-task-definition", "--task-definition", definitions[0].PhysicalResourceId])).taskDefinition;
    const container = definition?.containerDefinitions?.find((entry: any) => entry.name === descriptor.launch.containerName);
    if (!container?.environment?.some((entry: any) => entry.name === "DATABASE_REVIEW_PROTOCOL" && entry.value === String(DATABASE_REVIEW_PROTOCOL))) throw new EditError(422, "The deployed db-migrate task predates reviewed database protocol v1. Separately deploy the reviewed task update; Studio will not start an older write-only task for inspection.");
    const arn = definition.taskDefinitionArn as string;
    if (!arn || arn !== definitions[0].PhysicalResourceId || arn.split(":")[3] !== target.region || arn.split(":")[4] !== target.account) throw new EditError(409, "Task definition destination changed.");
    const logs = container.logConfiguration;
    if (logs?.logDriver !== "awslogs" || !logs.options?.["awslogs-group"] || !logs.options?.["awslogs-stream-prefix"]) throw new EditError(422, "The migration task needs its declared CloudWatch log transport before review can be confirmed.");
    return { identity: { deployment, account: target.account, region: target.region, taskDefinitionArn: arn }, profile, descriptor, logGroup: logs.options["awslogs-group"], streamPrefix: logs.options["awslogs-stream-prefix"] };
  }

  async prepare(deployment: string, profile: string): Promise<DatabaseCloudDestination> {
    const destination = await this.destination(deployment, profile);
    const result: DatabaseCloudDestination = { id: randomUUID(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), identity: destination.identity, profile, protocol: DATABASE_REVIEW_PROTOCOL, binding: destinationBinding(destination), launch: destination.descriptor.launch, logs: { group: destination.logGroup, streamPrefix: destination.streamPrefix }, effects: ["Read-only AWS identity, stack and task-definition inspection completed. No database task has started.", "Inspect starts one billed Fargate task using the declared VPC networking shown below. Public-IP assignment can be enabled; the database remains private and uses IAM/TLS. CloudWatch and network transport can also incur usage charges.", "Inspection reads schema metadata, marker and migration ledger. It does not apply SQL or query application rows.", "Applying SQL requires a second explicit approval after review. Infrastructure deployment remains separate."] };
    for (const [id, preparation] of this.preparations) if (Date.parse(preparation.expiresAt) <= Date.now()) this.preparations.delete(id);
    this.preparations.set(result.id, result);
    return result;
  }

  private async execute(destination: Destination, mode: "review" | "apply", inputsDigest: string, expectedDigest?: string, kind?: "migrate" | "initialize", reviewedMigrations: readonly string[] = []): Promise<DatabaseCloudEnvelope & { result?: DatabaseApplicationResult }> {
    const { identity, profile, descriptor } = destination;
    const request: DatabaseCloudRequest = { version: 1, requestId: randomUUID(), mode, identity, inputsDigest, ...(expectedDigest ? { expectedDigest } : {}) };
    let record: DatabaseOperationRecord = { id: randomUUID(), requestId: request.requestId, ownerPid: process.pid, kind: mode === "review" ? "inspect-production" : kind === "initialize" ? "initialize" : "migrate", targetLabel: `${identity.deployment} · ${identity.account} · ${identity.region}`, targetIdentity: digest(identity), sourceHash: inputsDigest, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running", stage: mode === "review" ? "inspecting" : "executing", migrations: [], cloudRecovery: { profile, region: identity.region, cluster: descriptor.launch.cluster, logGroup: destination.logGroup, logStream: "Determine from task ARN before inspecting logs" } };
    record = { ...record, ...(expectedDigest ? { reviewDigest: expectedDigest } : {}), migrations: reviewedMigrations };
    this.store.write(record);
    const launch = descriptor.launch;
    let attempted = false;
    try {
      attempted = true;
      const response = await this.aws(profile, identity.region, ["ecs", "run-task", "--cluster", launch.cluster, "--task-definition", identity.taskDefinitionArn, "--launch-type", launch.launchType, "--platform-version", launch.platformVersion, "--count", "1", "--client-token", request.requestId, "--started-by", request.requestId, "--propagate-tags", "TASK_DEFINITION", "--network-configuration", JSON.stringify({ awsvpcConfiguration: { subnets: launch.subnets, securityGroups: launch.securityGroups, assignPublicIp: launch.assignPublicIp ? "ENABLED" : "DISABLED" } }), "--overrides", JSON.stringify(buildTaskOverrides(launch.containerName, JSON.stringify(request)))]);
      const taskArn = response.tasks?.[0]?.taskArn as string | undefined;
      if (!taskArn || response.failures?.length) throw new Error("DATABASE_TASK_START_UNCONFIRMED");
      if (taskArn.split(":")[3] !== identity.region || taskArn.split(":")[4] !== identity.account) throw new Error("DATABASE_TASK_DESTINATION_CHANGED");
      record = { ...record, taskArn, cloudRecovery: { profile, region: identity.region, cluster: launch.cluster, logGroup: destination.logGroup, logStream: `${destination.streamPrefix}/${launch.containerName}/${taskArn.split("/").at(-1)}` }, updatedAt: new Date().toISOString() }; this.store.write(record);
      const timeout = Date.now() + 15 * 60_000;
      let stopped = false;
      let exitCode: number | undefined;
      while (Date.now() < timeout) {
        const tasks = await this.aws(profile, identity.region, ["ecs", "describe-tasks", "--cluster", launch.cluster, "--tasks", taskArn]);
        const task = tasks.tasks?.[0];
        if (!task || task.taskDefinitionArn !== identity.taskDefinitionArn) throw new Error("DATABASE_TASK_IDENTITY_CHANGED");
        if (task.lastStatus === "STOPPED") { stopped = true; exitCode = task.containers?.find((container: any) => container.name === launch.containerName)?.exitCode; break; }
        await delay(this.env.FRAMEWORK_POLL_MS ? Math.max(1, Number(this.env.FRAMEWORK_POLL_MS)) : 2000);
      }
      if (!stopped) throw new Error("DATABASE_TASK_OUTCOME_TIMEOUT");
      const stream = `${destination.streamPrefix}/${launch.containerName}/${taskArn.split("/").at(-1)}`;
      let envelope: DatabaseCloudEnvelope | undefined;
      for (let attempt = 0; attempt < 10 && !envelope; attempt++) {
        try {
        const messages: string[] = [];
        let token: string | undefined;
        for (let page = 0; page < 100; page++) {
          const result = await this.aws(profile, identity.region, ["logs", "get-log-events", "--log-group-name", destination.logGroup, "--log-stream-name", stream, "--start-from-head", ...(token ? ["--next-token", token] : [])]);
          messages.push(...(result.events ?? []).map((event: any) => event.message).filter((message: unknown): message is string => typeof message === "string"));
          if (messages.reduce((bytes, message) => bytes + message.length, 0) > 6 * 1024 * 1024) throw new Error("DATABASE_TASK_OUTPUT_TOO_LARGE");
          if (!result.nextForwardToken || result.nextForwardToken === token) break;
          token = result.nextForwardToken;
        }
        envelope = decodeDatabaseEnvelope(messages, request.requestId);
        } catch { if (attempt < 9) await delay(this.env.FRAMEWORK_POLL_MS ? 1 : 1500); }
      }
      if (!envelope) throw new Error("DATABASE_TASK_OUTPUT_UNCONFIRMED");
      if (["reviewed", "applied", "unchanged"].includes(envelope.status) && exitCode !== 0) throw new Error("DATABASE_TASK_EXIT_UNCONFIRMED");
      if (envelope.review && (digest(envelope.review.identity) !== digest(identity) || envelope.review.inputsDigest !== inputsDigest)) throw new Error("DATABASE_REVIEW_IDENTITY_CHANGED");
      const result: DatabaseApplicationResult = { status: envelope.status === "applied" ? "applied" : ["reviewed", "unchanged"].includes(envelope.status) ? "unchanged" : envelope.status === "refused" ? "failed" : "unconfirmed", database: envelope.status === "applied" ? "applied" : envelope.status === "unconfirmed" ? "unconfirmed" : "unchanged", targetId: "production", source: "unchanged", artifacts: "unchanged", applied: (envelope.applied ?? []).map(name => ({ name, from: "reviewed", to: "reviewed" })), operationId: record.id, stage: "complete", message: mode === "review" ? envelope.status === "reviewed" ? "The VPC task returned a read-only database review. No database changes were authorized." : "The VPC task refused database review; inspect its stable diagnostic and deployed task version." : envelope.status === "applied" ? kind === "initialize" ? "The VPC task confirmed reviewed empty database initialization. Inspect application behavior and database state separately." : "The VPC task confirmed reviewed migrations applied. Inspect application behavior and database state separately." : envelope.status === "unchanged" ? "The reviewed task found no pending migrations. No database changes were applied." : "Database application was refused or could not be confirmed. Inspect this exact task and database before retrying.", ...(envelope.code ? { diagnostic: { code: envelope.code, action: "Inspect the recorded task, database marker and migration ledger before another review. Do not retry an unconfirmed write automatically." } } : {}) };
      let outcome = result;
      try { this.store.write({ ...record, migrations: envelope.review?.migrations.map(migration => `${migration.spaceId}/${migration.dirName}`) ?? envelope.applied ?? [], status: envelope.status === "reviewed" ? "reviewed" : result.status, stage: "complete", updatedAt: new Date().toISOString(), result, message: result.message }); }
      catch { outcome = { ...result, message: `${result.message} The local operation journal could not record this confirmed result. Preserve this result and inspect the exact task before another operation.` }; }
      return { ...envelope, operationId: record.id, result: outcome };
    } catch {
      const result: DatabaseApplicationResult = { operationId: record.id, stage: record.stage, status: mode === "apply" && attempted ? "unconfirmed" : "failed", database: mode === "apply" && attempted ? "unconfirmed" : "unchanged", targetId: "production", source: "unchanged", artifacts: "unchanged", applied: [], message: "Task transport or outcome could not be confirmed. Review the recorded task ARN/client token and CloudWatch logs; a submitted task may continue even without a returned ARN. Never repeat an unconfirmed database write merely to refresh status.", diagnostic: { code: "DATABASE_CLOUD_OUTCOME_UNCONFIRMED", action: "Inspect the exact recorded task and database marker/ledger before requesting another review." } };
      this.store.write({ ...record, status: result.status, updatedAt: new Date().toISOString(), result });
      throw new EditError(422, result.message);
    }
  }

  async review(deployment: string, profile: string, confirmation: string, preparationId: string): Promise<DatabaseCloudApproval> {
    if (confirmation !== `Inspect ${deployment}`) throw new EditError(400, `Type Inspect ${deployment} to authorize a billed read-only task. It will not apply database changes.`);
    const destination = await this.destination(deployment, profile);
    const preparation = this.preparations.get(preparationId);
    if (!preparation || Date.parse(preparation.expiresAt) <= Date.now() || preparation.profile !== profile || preparation.binding !== destinationBinding(destination)) throw new EditError(409, "The prepared production destination expired or changed, including its launch/network/log descriptor. Check its exact destination again; no task was started.");
    this.preparations.delete(preparationId);
    const envelope = await this.execute(destination, "review", databaseInputsDigest(this.root));
    if (envelope.status !== "reviewed" || !envelope.review) throw new EditError(422, `${envelope.code ?? "DATABASE_REVIEW_REFUSED"}: production database review was refused. Check the recorded task, source/image currency and physical database history.`);
    const approval: DatabaseCloudApproval = { id: randomUUID(), profile, destination: preparation, review: envelope.review, confirmation: `${envelope.review.kind === "initialize" ? "Initialize" : "Apply"} ${deployment}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  async apply(id: string, confirmation: string): Promise<DatabaseApplicationResult> {
    const approval = this.approvals.get(id);
    if (!approval || Date.parse(approval.expiresAt) <= Date.now()) throw new EditError(409, "Production database review expired. Request a new read-only review before applying.");
    if (confirmation !== approval.confirmation) throw new EditError(400, `Type ${approval.confirmation} to authorize these reviewed production database changes.`);
    const release = this.store.lock(); if (!release) throw new EditError(409, "A database operation lock exists. Inspect operation history and its owning process before recovery or retry.");
    try {
      const destination = await this.destination(approval.review.identity.deployment, approval.profile);
      if (destinationBinding(destination) !== approval.destination.binding || databaseInputsDigest(this.root) !== approval.review.inputsDigest) throw new EditError(409, "Source, account, region, task definition or launch/network/log descriptor changed after review. No database task was started; review again.");
      this.approvals.delete(id);
      const envelope = await this.execute(destination, "apply", approval.review.inputsDigest, approval.review.digest, approval.review.kind, approval.review.migrations.map(migration => `${migration.spaceId}/${migration.dirName}`));
      return envelope.result!;
    } finally { release(); }
  }
}
