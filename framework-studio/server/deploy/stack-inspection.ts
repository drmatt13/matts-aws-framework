import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseDocument } from "yaml";
import { stackEvidence, stackLocation } from "@repo/framework/deploy";
import { classifyAwsError } from "../../../scripts/aws-cli";
import { classifyAwsConnectionError, connectionEnvironment, createAwsExecutionSnapshot } from "../../../scripts/aws-connections";
import type { AwsProblem } from "../../shared/deploy";
import type { InspectionJson, InspectionResult, StackInspectionBase, StackInspectionRequest, StackInspectionSections, StackParameter, StackChangeSetSummary, StackOverview } from "../../shared/stack-inspection";
import type { Runner, Tools } from "./process";
import { OperationError } from "./registry";

const MAX_BYTES = 2 * 1024 * 1024;
const TTL = 10_000;
const SECTIONS = new Set(["overview", "resources", "events", "outputs", "parameters", "template", "tags", "change-sets", "change-set", "dependencies", "export-imports"]);
const text = (value: unknown): string => typeof value === "string" ? value : "";
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const optional = (value: unknown): string | undefined => text(value) || undefined;
const drift = (value: any) => ({ status: text(value?.StackDriftStatus ?? value?.StackResourceDriftStatus) || "NOT_CHECKED", lastCheckedAt: optional(value?.LastCheckTimestamp) });
const tags = (value: unknown) => list(value).map(item => ({ key: text(item.Key), value: text(item.Value) }));
const rollback = (value: any): StackOverview["rollback"] => ({ monitoringMinutes: typeof value?.MonitoringTimeInMinutes === "number" ? value.MonitoringTimeInMinutes : undefined, triggers: list(value?.RollbackTriggers).map(item => ({ arn: text(item.Arn), type: text(item.Type) })) });
const problem = (kind: AwsProblem["kind"], message: string): InspectionResult<never> => ({ ok: false, problem: { kind, message } });

class ReadFailure extends Error { constructor(readonly problem: AwsProblem) { super(problem.message); } }
interface Entry { readonly promise: Promise<InspectionResult<unknown>>; completedAt?: number }
interface Cursor { readonly scope: string; readonly token: string }

/** Selected-stack reads only. No account-wide stack listing, credential resolution, or mutation. */
export class StackInspector {
  private readonly cache = new Map<string, Entry>();
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly tools: Tools, private readonly run: Runner, private readonly baseEnv: NodeJS.ProcessEnv) {}

  invalidate(): void { this.cache.clear(); }

  private encode(scope: string, token: string): string {
    const payload = Buffer.from(JSON.stringify({ scope, token } satisfies Cursor)).toString("base64url");
    return `${payload}.${createHmac("sha256", this.cursorKey).update(payload).digest("base64url")}`;
  }
  private decode(cursor: string | undefined, scope: string): string | undefined {
    if (!cursor) return undefined;
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra || cursor.length > 24_000) throw new OperationError(400, "That page cursor is invalid. Refresh this stack section.");
    const expected = createHmac("sha256", this.cursorKey).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new OperationError(400, "That page cursor is invalid. Refresh this stack section.");
    let value: Cursor; try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new OperationError(400, "That page cursor is invalid."); }
    if (value.scope !== scope || typeof value.token !== "string" || value.token.length > 16_384) throw new OperationError(400, "That page cursor belongs to another stack, connection, or section. Refresh this section.");
    return value.token;
  }

  async inspect<S extends keyof StackInspectionSections>(request: StackInspectionRequest & { section: S }, force = false, owner: { readonly appId?: string; readonly stage?: string } = {}): Promise<InspectionResult<StackInspectionSections[S]>> {
    validate(request);
    const snapshot = createAwsExecutionSnapshot(this.baseEnv);
    try {
      const env = connectionEnvironment(snapshot.environment, request.profile, { region: request.region });
      const read = async (service: string, verb: string, input: Record<string, unknown> = {}): Promise<any> => {
        const result = await this.run(this.tools.aws([service, verb, "--cli-input-json", JSON.stringify(input), "--no-paginate", "--output", "json", "--profile", request.profile, "--region", request.region], env), { timeoutMs: 45_000 });
        if (result.code !== 0) {
          if (service === "cloudformation" && verb === "list-imports" && /not imported by any stack/i.test(result.stderr)) return { Imports: [] };
          const connection = classifyAwsConnectionError(result.stderr, result.missing);
          throw new ReadFailure({ kind: classifyAwsError(result.missing ? "ENOENT" : result.stderr), message: connection.message });
        }
        if (Buffer.byteLength(result.stdout) > MAX_BYTES) throw new ReadFailure({ kind: "failed", message: "AWS returned more data than this inspector can display. Open this section in the AWS console." });
        try { return result.stdout.trim() ? JSON.parse(result.stdout) : {}; } catch { throw new ReadFailure({ kind: "failed", message: "AWS returned an unreadable response." }); }
      };
      // Resolve the actor from the very same private profile snapshot used below.
      const caller = await read("sts", "get-caller-identity");
      if (caller.Account !== request.account || typeof caller.Arn !== "string") throw new OperationError(409, "The selected AWS identity changed. Refresh deployment status before inspecting this stack.");
      const described = await read("cloudformation", "describe-stacks", { StackName: request.stackId ?? request.stack });
      const stack = list(described.Stacks)[0];
      if (!stack || stack.StackName !== request.stack || !validStackId(stack.StackId, request)) throw new OperationError(409, "The selected stack no longer matches this deployment. Refresh deployment status.");
      if (request.stackId && stack.StackId !== request.stackId) throw new OperationError(409, "The stack was replaced. Refresh deployment status before inspecting it.");
      let evidence = stackEvidence(stack);
      if (evidence.evidence === "none" && !evidence.problem) {
        const summary = await read("cloudformation", "get-template-summary", { StackName: stack.StackId });
        let metadata: unknown; try { metadata = JSON.parse(text(summary.Metadata)); } catch { /* Unverifiable ownership is refused below. */ }
        evidence = stackEvidence(stack, { Metadata: metadata });
        // Legacy stacks have only the identity output, which a failed first
        // create retains in its template before CloudFormation exposes outputs.
        if (evidence.evidence === "none" && !evidence.problem) {
          const template = await read("cloudformation", "get-template", { StackName: stack.StackId, TemplateStage: "Original" });
          evidence = stackEvidence(stack, template.TemplateBody);
        }
      }
      const identity = evidence.identity;
      if (evidence.problem || !identity || identity.deployment !== request.deployment || identity.mode !== request.mode || identity.account !== request.account || identity.region !== request.region) throw new OperationError(409, "This stack does not carry a matching framework deployment identity. Refresh deployment status.");
      if (owner.appId && identity.appId && owner.appId !== identity.appId || owner.stage && identity.stage && owner.stage !== identity.stage) throw new OperationError(409, "This stack belongs to a different application's deployment stage. Refresh deployment status.");
      const scope = JSON.stringify([snapshot.revision, request.profile, caller.Account, caller.Arn, request.region, request.deployment, request.mode, owner.appId, owner.stage, stack.StackId, request.section, request.changeSetId ?? "", request.stage ?? "Original", request.exportName ?? ""]);
      const token = this.decode(request.cursor, scope);
      const key = `${scope}|${request.cursor ?? ""}`;
      const cached = this.cache.get(key);
      if (cached && (cached.completedAt === undefined || !force && Date.now() - cached.completedAt < TTL)) return await cached.promise as InspectionResult<StackInspectionSections[S]>;
      const base: StackInspectionBase = { stackId: stack.StackId, observedAt: new Date().toISOString() };
      const promise = this.section(request, stack, base, token, scope, read).then(value => {
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) return problem("failed", "This section exceeds the inspector display limit. Open it in the AWS console.");
        return { ok: true as const, value };
      }, error => { if (error instanceof ReadFailure) return { ok: false as const, problem: error.problem }; throw error; });
      const entry: Entry = { promise };
      this.cache.set(key, entry);
      void promise.then(value => { if (this.cache.get(key) !== entry) return; if (value.ok) entry.completedAt = Date.now(); else this.cache.delete(key); }, () => { if (this.cache.get(key) === entry) this.cache.delete(key); });
      if (this.cache.size > 200) { const oldest = this.cache.keys().next().value; if (oldest) this.cache.delete(oldest); }
      return await promise as InspectionResult<StackInspectionSections[S]>;
    } catch (error) {
      if (error instanceof ReadFailure) return { ok: false, problem: error.problem };
      throw error;
    } finally { snapshot.dispose(); }
  }

  private async section(request: StackInspectionRequest, stack: any, base: StackInspectionBase, token: string | undefined, scope: string, read: (service: string, verb: string, input?: Record<string, unknown>) => Promise<any>): Promise<unknown> {
    const cfn = (verb: string, extra: Record<string, unknown> = {}) => read("cloudformation", verb, { StackName: base.stackId, ...extra });
    const page = (items: unknown[], next: unknown) => {
      if (typeof next === "string" && next && next === token) throw new ReadFailure({ kind: "failed", message: "AWS repeated a page token. Refresh this stack section." });
      return { ...base, items, ...(typeof next === "string" && next ? { nextCursor: this.encode(scope, next) } : {}) };
    };
    const paged = token ? { NextToken: token } : {};
    switch (request.section) {
      case "overview": {
        let policy: InspectionResult<{ body?: string }>;
        try { const value = await cfn("get-stack-policy"); policy = { ok: true, value: { body: optional(value?.StackPolicyBody) } }; }
        catch (error) { if (!(error instanceof ReadFailure)) throw error; policy = { ok: false, problem: error.problem }; }
        return { ...base, name: stack.StackName, status: stack.StackStatus, statusReason: optional(stack.StackStatusReason), detailedStatus: optional(stack.DetailedStatus), retainExceptOnCreate: stack.RetainExceptOnCreate, deletionMode: optional(stack.DeletionMode), description: optional(stack.Description), createdAt: optional(stack.CreationTime), updatedAt: optional(stack.LastUpdatedTime), deletedAt: optional(stack.DeletionTime), parentId: optional(stack.ParentId), rootId: optional(stack.RootId), roleArn: optional(stack.RoleARN), terminationProtection: stack.EnableTerminationProtection === true, disableRollback: stack.DisableRollback === true, timeoutMinutes: stack.TimeoutInMinutes, capabilities: list(stack.Capabilities), notificationArns: list(stack.NotificationARNs), rollback: rollback(stack.RollbackConfiguration), drift: drift(stack.DriftInformation), policy };
      }
      case "resources": {
        const value = await cfn("list-stack-resources", paged);
        return page(list(value.StackResourceSummaries).map(item => ({ logicalId: text(item.LogicalResourceId), physicalId: optional(item.PhysicalResourceId), type: text(item.ResourceType), status: text(item.ResourceStatus), statusReason: optional(item.ResourceStatusReason), updatedAt: optional(item.LastUpdatedTimestamp), drift: item.DriftInformation ? drift(item.DriftInformation) : undefined, module: item.ModuleInfo ? { logicalIdHierarchy: optional(item.ModuleInfo.LogicalIdHierarchy), typeHierarchy: optional(item.ModuleInfo.TypeHierarchy) } : undefined })), value.NextToken);
      }
      case "events": {
        const value = await cfn("describe-stack-events", paged);
        // ResourceProperties is intentionally excluded: it can contain credentials.
        return page(list(value.StackEvents).map(item => ({ id: text(item.EventId), time: text(item.Timestamp), logicalId: text(item.LogicalResourceId), physicalId: optional(item.PhysicalResourceId), type: text(item.ResourceType), status: text(item.ResourceStatus), reason: optional(item.ResourceStatusReason), clientRequestToken: optional(item.ClientRequestToken), detailedStatus: optional(item.DetailedStatus) })), value.NextToken);
      }
      case "outputs": return page(list(stack.Outputs).map(item => ({ key: text(item.OutputKey), value: text(item.OutputValue), description: optional(item.Description), exportName: optional(item.ExportName) })), undefined);
      case "tags": return page(tags(stack.Tags), undefined);
      case "parameters": {
        const masked = await maskParameters(stack.Parameters, () => cfn("get-template-summary"));
        return { ...base, items: masked.items, ...(masked.problem ? { maskingProblem: masked.problem } : {}) };
      }
      case "template": {
        const stage = request.stage ?? "Original";
        const value = await cfn("get-template", { TemplateStage: stage });
        const sanitized = redactTemplate(value.TemplateBody);
        return { ...base, stage, availableStages: list(value.StagesAvailable), ...sanitized };
      }
      case "change-sets": {
        const value = await cfn("list-change-sets", paged);
        return page(list(value.Summaries).map(changeSetSummary), value.NextToken);
      }
      case "change-set": {
        // An ARN can name another stack even when StackName is supplied. Verify
        // membership from this exact stack's list before requesting its details.
        let found = false; let next: string | undefined; const seen = new Set<string>();
        do {
          const value = await cfn("list-change-sets", next ? { NextToken: next } : {});
          found = list(value.Summaries).some(item => item.ChangeSetId === request.changeSetId);
          next = optional(value.NextToken);
          if (next && seen.has(next)) throw new ReadFailure({ kind: "failed", message: "AWS repeated a change set page token." });
          if (next) seen.add(next);
          if (seen.size >= 50) throw new ReadFailure({ kind: "failed", message: "There are too many change sets to verify this selection. Open it in the AWS console." });
        } while (!found && next);
        if (!found) throw new OperationError(409, "That change set does not belong to this stack or no longer exists.");
        const value = await cfn("describe-change-set", { ChangeSetName: request.changeSetId, IncludePropertyValues: true, ...paged });
        if (value.StackId !== base.stackId || value.ChangeSetId !== request.changeSetId) throw new OperationError(409, "That change set does not belong to this stack.");
        const masked = await maskParameters(value.Parameters, async () => {
          const template = await cfn("get-template", { ChangeSetName: request.changeSetId, TemplateStage: "Original" });
          return { Parameters: templateParameters(template.TemplateBody) };
        });
        return { ...page(list(value.Changes).map(item => redactKnown(item, masked.hidden, masked.sensitive)) as InspectionJson[], value.NextToken), summary: changeSetSummary(value), parameters: masked.items, ...(masked.problem ? { maskingProblem: masked.problem } : {}), capabilities: list(value.Capabilities), notificationArns: list(value.NotificationARNs), tags: tags(value.Tags), rollback: rollback(value.RollbackConfiguration), onStackFailure: optional(value.OnStackFailure), importExistingResources: value.ImportExistingResources };
      }
      case "export-imports": {
        if (!list(stack.Outputs).some(item => item.ExportName === request.exportName)) throw new OperationError(409, "That export does not belong to this stack.");
        const value = await read("cloudformation", "list-imports", { ExportName: request.exportName, ...paged });
        return page(list(value.Imports).filter(item => typeof item === "string"), value.NextToken);
      }
      case "dependencies": {
        const exports = list(stack.Outputs).filter(item => typeof item.ExportName === "string").map(item => ({ name: item.ExportName, value: text(item.OutputValue) }));
        let imports: string[] = []; let importsNote: string | undefined;
        try { const value = await cfn("get-template", { TemplateStage: "Processed" }); imports = templateImports(value.TemplateBody); }
        catch (error) { if (!(error instanceof ReadFailure)) throw error; importsNote = error.problem.message; }
        return { ...base, exports, imports, importsNote: importsNote ?? "Import names come from the deployed template. Expressions remain unresolved." };
      }
    }
  }
}

function validStackId(value: unknown, request: StackInspectionRequest): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  const location = stackLocation(value);
  return Boolean(location && location.account === request.account && location.region === request.region && /^arn:[^:]+:cloudformation:[^:]+:\d{12}:stack\/[^/]+\/[^/]+$/.test(value));
}
function validate(request: StackInspectionRequest): void {
  if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(request.deployment) || !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(request.stack) || !/^\d{12}$/.test(request.account) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(request.region) || !["dev", "prod"].includes(request.mode) || !SECTIONS.has(request.section)) throw new OperationError(400, "Choose a deployment, account, region, stack, and section.");
  if (request.section !== "overview" && !request.stackId) throw new OperationError(400, "Open the stack overview before loading its details.");
  if (request.stackId && !validStackId(request.stackId, request)) throw new OperationError(400, "That stack ARN does not match the selected account and region.");
  if (request.section === "change-set" && (!request.changeSetId || !/^arn:[^:]+:cloudformation:[^:]+:\d{12}:changeSet\/[^/]+\/[^/]+$/.test(request.changeSetId) || !request.changeSetId.startsWith(request.stackId!.split(":stack/")[0] + ":changeSet/"))) throw new OperationError(400, "Choose a change set from this stack.");
  if (request.section === "export-imports" && (!request.exportName || request.exportName.length > 1024)) throw new OperationError(400, "Choose an export from this stack.");
  if (request.stage !== undefined && request.stage !== "Original" && request.stage !== "Processed") throw new OperationError(400, "Choose the Original or Processed template.");
  if (request.cursor && !["events", "resources", "change-sets", "change-set", "export-imports"].includes(request.section)) throw new OperationError(400, "This section does not have additional pages.");
}
function changeSetSummary(value: any): StackChangeSetSummary {
  return { id: text(value.ChangeSetId), name: text(value.ChangeSetName), status: text(value.Status), executionStatus: optional(value.ExecutionStatus), statusReason: optional(value.StatusReason), description: optional(value.Description), createdAt: optional(value.CreationTime), type: optional(value.ChangeSetType), includeNestedStacks: value.IncludeNestedStacks, parentId: optional(value.ParentChangeSetId), rootId: optional(value.RootChangeSetId) };
}
async function maskParameters(values: unknown, summary: () => Promise<any>): Promise<{ items: StackParameter[]; hidden: string[]; sensitive: boolean; problem?: AwsProblem }> {
  let declarations: any[] = []; let unreadable: AwsProblem | undefined;
  try { declarations = list((await summary()).Parameters); } catch (error) { if (!(error instanceof ReadFailure)) throw error; unreadable = error.problem; }
  const hidden: string[] = [];
  const items = list(values).map(value => {
    const declaration = declarations.find(item => item.ParameterKey === value.ParameterKey);
    const masked = Boolean(unreadable || !declaration || declaration.NoEcho === true || declaration.NoEcho === "true");
    if (masked && typeof value.ParameterValue === "string" && !/^\*+$/.test(value.ParameterValue)) hidden.push(value.ParameterValue);
    return { key: text(value.ParameterKey), value: masked ? "••••••••" : text(value.ParameterValue), resolvedValue: typeof value.ResolvedValue === "string" ? masked ? "••••••••" : value.ResolvedValue : undefined, type: optional(declaration?.ParameterType), description: optional(declaration?.Description), masked, usePreviousValue: value.UsePreviousValue };
  });
  return { items, hidden, sensitive: Boolean(unreadable || items.some(item => item.masked) || declarations.some(item => item.NoEcho === true || item.NoEcho === "true")), problem: unreadable };
}
function redactKnown(value: any, hidden: readonly string[], maskContexts = false): InspectionJson {
  if (typeof value === "string") { let result = value; for (const secret of hidden.filter(Boolean)) result = result === secret ? "[redacted]" : secret.length >= 4 ? result.split(secret).join("[redacted]") : result; return result; }
  if (Array.isArray(value)) return value.map(item => redactKnown(item, hidden, maskContexts));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskContexts && ["BeforeContext", "AfterContext", "BeforeValue", "AfterValue"].includes(key) ? "[redacted: sensitive parameters]" : redactKnown(item, hidden, maskContexts)]));
  return value === null || typeof value === "boolean" || typeof value === "number" ? value : null;
}
/** Preserve deployed references and intrinsic syntax; only NoEcho defaults are removed. */
export function redactTemplate(value: unknown): { body: string; format: "json" | "yaml"; redactedDefaults: string[] } {
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (typeof raw !== "string") throw new ReadFailure({ kind: "failed", message: "AWS did not return a deployed template." });
  const json = raw.trimStart().startsWith("{");
  const doc = parseDocument(raw, { logLevel: "silent" });
  if (doc.errors.length) throw new ReadFailure({ kind: "failed", message: "The deployed template could not be parsed safely. Open it in the AWS console." });
  const parameters = doc.get("Parameters"); const redactedDefaults: string[] = [];
  if (parameters && typeof parameters === "object" && "items" in parameters) for (const entry of parameters.items as any[]) {
    const key = text(entry.key?.value); const noEcho = doc.getIn(["Parameters", key, "NoEcho"]);
    if ((noEcho === true || noEcho === "true") && doc.hasIn(["Parameters", key, "Default"])) { doc.setIn(["Parameters", key, "Default"], "[redacted]"); redactedDefaults.push(key); }
  }
  return { body: json ? JSON.stringify(doc.toJS(), null, 2) : doc.toString(), format: json ? "json" : "yaml", redactedDefaults };
}
function templateImports(value: unknown): string[] {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const doc = parseDocument(raw, { logLevel: "silent" });
  if (doc.errors.length) throw new ReadFailure({ kind: "failed", message: "The deployed template imports could not be read." });
  const found = new Set<string>();
  const visit = (item: any) => { if (!item || typeof item !== "object") return; if ("Fn::ImportValue" in item) found.add(typeof item["Fn::ImportValue"] === "string" ? item["Fn::ImportValue"] : JSON.stringify(item["Fn::ImportValue"])); for (const nested of Object.values(item)) visit(nested); };
  visit(doc.toJS());
  // YAML's short tags do not survive toJS(). Inspect their AST before that
  // projection, preserving expression syntax without evaluating Ref/Sub/Join.
  const shortImports = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.tag === "!ImportValue") found.add(typeof node.value === "string" ? node.value : String(node));
    if (Array.isArray(node.items)) for (const item of node.items) shortImports(item);
    if ("key" in node) shortImports(node.key);
    if ("value" in node) shortImports(node.value);
  };
  shortImports(doc.contents);
  return [...found].sort();
}
function templateParameters(value: unknown): any[] {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const doc = parseDocument(raw, { logLevel: "silent" });
  if (doc.errors.length) throw new ReadFailure({ kind: "failed", message: "The change set template parameter definitions could not be read safely." });
  const parameters = doc.toJS()?.Parameters;
  return parameters && typeof parameters === "object" ? Object.entries(parameters).map(([key, item]) => ({ ParameterKey: key, ParameterType: (item as any)?.Type, Description: (item as any)?.Description, NoEcho: (item as any)?.NoEcho === true || (item as any)?.NoEcho === "true" })) : [];
}
