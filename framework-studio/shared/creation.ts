import { validateTags, type DeclarationTags } from "@repo/framework/config/tags";

/** Source creation uses the inspector's batch transaction, never a file-writing API. */
export const CREATION_KINDS = ["function", "stack", "vpc", "workflow", "service", "task", "route", "agent", "tool", "input", "secret"] as const;
export type CreationKind = typeof CREATION_KINDS[number];
export type CreationDeploy = "both" | "local-only" | "cloud-only" | "none";
interface Named { readonly id: string; readonly description: string; readonly tags?: DeclarationTags; readonly implementation?: "create" | "existing" }
interface Binding { readonly bindingResource: string; readonly bindingVariable: string }
interface Lambda extends Named, Binding {
  readonly directory: string;
  readonly category: "event" | "http" | "webSocket";
  readonly runtime: "nodejs24" | "nodejs22";
  readonly memory: number;
  readonly timeout: number;
  readonly architecture: "arm64" | "x86_64";
  readonly vpc: string;
  readonly subnet: "none" | "private" | "isolated";
  readonly deploy: CreationDeploy;
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "*";
  readonly auth: boolean;
}
export type CreationRequest =
  | (Lambda & { readonly kind: "function" })
  | (Lambda & { readonly kind: "route"; readonly existingTarget: string })
  | (Named & { readonly kind: "stack"; readonly className: string; readonly template: "queue" | "bucket"; readonly scope: "both" | "dev" | "prod" })
  | (Named & { readonly kind: "vpc"; readonly name: string; readonly cidr: string; readonly zones: 2 | 3; readonly nat: boolean; readonly ipv6: boolean; readonly s3: boolean; readonly dynamodb: boolean; readonly endpoints: readonly string[] })
  | (Named & { readonly kind: "workflow"; readonly deploy: CreationDeploy; readonly timeout: number; readonly steps: readonly string[] })
  | (Named & Binding & { readonly kind: "service"; readonly directory: string; readonly path: string; readonly port: number; readonly auth: boolean; readonly deploy: CreationDeploy; readonly cpu: number; readonly memory: number; readonly architecture: "arm64" | "x86_64"; readonly vpc: string; readonly subnet: "public" | "private" })
  | (Named & Binding & { readonly kind: "task"; readonly directory: string; readonly deploy: CreationDeploy; readonly cpu: number; readonly memory: number; readonly architecture: "arm64" | "x86_64"; readonly vpc: string; readonly subnet: "public" | "private" })
  | (Named & Binding & { readonly kind: "agent"; readonly directory: string; readonly starter: "echo" | "model"; readonly deploy: CreationDeploy; readonly auth: boolean; readonly path: string; readonly tools: readonly string[] })
  | (Named & Binding & { readonly kind: "tool"; readonly directory: string; readonly auth: boolean })
  | (Named & { readonly kind: "input"; readonly envName: string; readonly group: string; readonly required: boolean; readonly defaultValue: string; readonly choices: readonly string[]; readonly consumer: string; readonly consumerVariable: string })
  | (Named & { readonly kind: "secret"; readonly envName: string; readonly group: string; readonly required: boolean; readonly consumer: string; readonly consumerVariable: string });

export interface CreationField {
  readonly key: string;
  readonly label: string;
  readonly initial: string | number | boolean;
  readonly type?: "text" | "number" | "boolean" | "list" | "tags";
  readonly options?: readonly string[];
  readonly advanced?: boolean;
  readonly help?: string;
}
const id: CreationField = { key: "id", label: "Stable identifier", initial: "", help: "Used for source paths and canonical identity. Lowercase letters, digits and hyphens." };
const description: CreationField = { key: "description", label: "Description", initial: "" };
const tags: CreationField = { key: "tags", label: "Tags", initial: "{}", type: "tags", help: "String key/value metadata. Review source changes before applying." };
const directory: CreationField = { key: "directory", label: "Implementation directory", initial: "", help: "Leave empty for the conventional folder. Lambda/container paths start under /lambda_functions or /ecs_containers in cdk-app; agents under /agents at the repository root. Starter files never overwrite existing code." };
const implementation: CreationField = { key: "implementation", label: "Implementation source", initial: "create", options: ["create", "existing"], help: "Create reviewed starter files, or use existing code after artifact/contract validation. Existing files are never overwritten." };
const deploy: CreationField = { key: "deploy", label: "Execution lanes", initial: "both", options: ["both", "local-only", "cloud-only", "none"] };
const binding: CreationField[] = [
  { key: "bindingResource", label: "Catalog resource", initial: "", advanced: true, help: "Optional input or secret reference. Secrets use automatic framework delivery and permissions." },
  { key: "bindingVariable", label: "Consumer environment variable", initial: "", advanced: true },
];
const lambda: CreationField[] = [id, description, tags, directory, implementation,
  { key: "category", label: "Function category", initial: "event", options: ["event", "http", "webSocket"] },
  { key: "path", label: "Route path or WebSocket key", initial: "", help: "HTTP paths begin with /. WebSocket routes use an action or $connect, $disconnect, $default." },
  { key: "method", label: "HTTP method", initial: "POST", options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"] },
  { key: "auth", label: "Require a signed-in user (HTTP)", initial: true, type: "boolean" }, deploy,
  { key: "runtime", label: "TypeScript zip runtime", initial: "nodejs24", options: ["nodejs24", "nodejs22"], advanced: true },
  { key: "memory", label: "Memory (MiB)", initial: 128, type: "number", advanced: true },
  { key: "timeout", label: "Timeout (seconds)", initial: 10, type: "number", advanced: true },
  { key: "architecture", label: "Architecture", initial: "arm64", options: ["arm64", "x86_64"], advanced: true },
  { key: "vpc", label: "VPC", initial: "", options: [] },
  { key: "subnet", label: "Network placement", initial: "none", options: ["none", "private", "isolated"], advanced: true }, ...binding,
];
const container: CreationField[] = [id, description, tags, directory, implementation, deploy,
  { key: "vpc", label: "VPC", initial: "", options: [] },
  { key: "cpu", label: "Fargate CPU units", initial: 256, type: "number", advanced: true },
  { key: "memory", label: "Memory (MiB)", initial: 512, type: "number", advanced: true },
  { key: "architecture", label: "Architecture", initial: "x86_64", options: ["arm64", "x86_64"], advanced: true },
  { key: "subnet", label: "Subnet", initial: "public", options: ["public", "private"], advanced: true, help: "Public containers use a billed public IPv4 address. Private containers need the network's NAT gateway or ECR and Logs endpoints." }, ...binding,
];
const input: CreationField[] = [
  { ...id, help: "TypeScript catalog property name, such as partnerToken." }, description, tags,
  { key: "envName", label: "Environment variable", initial: "", help: "Authored values live in cdk-app/.env.dev or .env.prod. Creation does not write values." },
  { key: "group", label: "Catalog group", initial: "", advanced: true },
  { key: "required", label: "Required for every enabled consumer", initial: false, type: "boolean" },
  { key: "consumer", label: "Existing workload consumer (optional)", initial: "", advanced: true },
  { key: "consumerVariable", label: "Consumer environment variable", initial: "", advanced: true },
];
export const CREATORS: Record<CreationKind, { readonly label: string; readonly help: string; readonly fields: readonly CreationField[] }> = {
  function: { label: "Function", help: "Creates a TypeScript zip Lambda and its section registration. Events are AWS-invoked and have no deployment toggle; add their triggers in the Inspector.", fields: lambda },
  route: { label: "API route", help: "Register an HTTP or WebSocket route with a new handler, or reuse a compatible routed Lambda. Existing targets keep their runtime, bindings and construct identity.", fields: [...lambda.map((field) => field.key === "category" ? { ...field, initial: "http", options: ["http", "webSocket"] } : field), { key: "existingTarget", label: "Existing compatible function (optional)", initial: "" }] },
  stack: { label: "Stack", help: "Creates an application stack exposing a queue or private encrypted upload bucket. Infrastructure is billed only after separate deployment. Bucket data is retained on removal; custom CDK members remain source-owned.", fields: [{ ...id, help: "TypeScript resource catalog property." }, description, tags, { key: "className", label: "Stack class name", initial: "" }, { key: "template", label: "Resource template", initial: "queue", options: ["queue", "bucket"] }, { key: "scope", label: "Deployment graphs", initial: "both", options: ["both", "dev", "prod"] }] },
  vpc: { label: "VPC", help: "Create an independent framework VPC. Each zone has public, private and isolated subnets. Production builds it when a workload or native resource uses it. Changing CIDR or zones can replace existing infrastructure on deployment.", fields: [id, { key: "name", label: "Display name", initial: "", help: "Optional friendly name. You can change it later without changing the VPC identity." }, description, tags, { key: "cidr", label: "Private IPv4 /16", initial: "10.0.0.0/16", help: "Choose an unused range. Studio refuses overlapping ranges to avoid future connectivity conflicts." }, { key: "zones", label: "Availability zones", initial: 2, type: "number" }, { key: "nat", label: "One NAT gateway (billed hourly and per GB)", initial: false, type: "boolean" }, { key: "ipv6", label: "IPv6 egress-only gateway", initial: true, type: "boolean" }, { key: "s3", label: "S3 gateway endpoint", initial: true, type: "boolean" }, { key: "dynamodb", label: "DynamoDB gateway endpoint", initial: true, type: "boolean" }, { key: "endpoints", label: "Interface endpoints", initial: "", type: "list", advanced: true, help: "Each service incurs hourly charges in each zone and per GB." }] },
  workflow: { label: "Workflow", help: "An executable identity workflow, or an initial sequence of existing event Lambdas and tasks. Input flows through the existing workflow DSL and interpreter.", fields: [id, description, tags, deploy, { key: "timeout", label: "Execution timeout (seconds)", initial: 900, type: "number" }, { key: "steps", label: "Initial targets, in order (comma-separated)", initial: "", type: "list", help: "Use canonical refs such as lambda:validate or task:process." }] },
  service: { label: "Container service", help: "Creates a Node HTTP service, Dockerfile and declaration. Local Compose is derived from the declaration. Cloud services incur ECS, load balancer and IPv4 charges after a separate deployment.", fields: [...container.map((field) => field.key === "deploy" ? { ...field, initial: "local-only" } : field), { key: "path", label: "Public mount", initial: "", help: "For example /reports/*; requests reach the service without this prefix." }, { key: "port", label: "Container port", initial: 5000, type: "number" }, { key: "auth", label: "Require a signed-in user", initial: true, type: "boolean" }] },
  task: { label: "Container task", help: "Creates a run-to-completion Node container reading FRAMEWORK_TASK_INPUT. Invoke it through a declared runsTask binding or workflow step; timeouts belong to the invocation.", fields: container },
  agent: { label: "Agent", help: "Creates a validated JSON agent. Echo runs without a model call or provider prerequisites; Model and tools uses shared provider configuration and incurs provider charges when invoked.", fields: [id, description, tags, directory, implementation, deploy, { key: "starter", label: "Starter behavior", initial: "echo", options: ["echo", "model"] }, { key: "auth", label: "Require a signed-in user", initial: true, type: "boolean" }, { key: "path", label: "Browser route (optional, authenticated agents)", initial: "" }, { key: "tools", label: "Declared tool IDs (comma-separated)", initial: "", type: "list" }, ...binding] },
  tool: { label: "Agent tool", help: "Creates a Lambda tool with a validated request/response contract. A tool runs where an agent that lists it runs; add it to an agent after source review.", fields: [id, description, tags, directory, implementation, { key: "auth", label: "Act as the signed-in user", initial: true, type: "boolean" }, ...binding] },
  input: { label: "Input parameter", help: "Inputs are strings in this framework; choices constrain recognized values. Defaults belong to declarations. No environment-specific values are overwritten.", fields: [...input, { key: "defaultValue", label: "Declaration default (optional)", initial: "" }, { key: "choices", label: "Allowed string values (comma-separated)", initial: "", type: "list", advanced: true }] },
  secret: { label: "Secret", help: "Declares a secret without a value. Use the protected environment-file Inspector to author values separately. AWS provisioning requires a separately authorized deployment.", fields: input },
};

export class CreationValidationError extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}
/** Studio's safety policy is stricter than the DSL: isolated VPCs may overlap
 * in source, but the creator never introduces an accidental overlapping range. */
export const networkCidrIdentity = (cidr: string): string => cidr.split("/")[0]!.split(".").map(Number).join(".");
export function networkCreationProblem(request: Pick<Extract<CreationRequest, { kind: "vpc" }>, "id" | "cidr">, networks: readonly { readonly id: string; readonly cidr: string; readonly constructId?: string }[], editing = false): CreationValidationError | undefined {
  const existing = networks.filter(network => !editing || network.id !== request.id);
  if (existing.some(network => network.id === request.id)) return new CreationValidationError("id", "This VPC identifier already exists. Choose a different stable identifier.");
  const constructId = `${request.id.split("-").map(part => part[0]!.toUpperCase() + part.slice(1)).join("")}NetworkStack`;
  if (!editing && existing.some(network => network.constructId === constructId)) return new CreationValidationError("id", "This identifier would reuse an existing deployed construct identity. Choose another identifier.");
  const overlap = existing.find(network => networkCidrIdentity(network.cidr) === networkCidrIdentity(request.cidr));
  if (overlap) return new CreationValidationError("cidr", `This range overlaps VPC "${overlap.id}" (${overlap.cidr}). Choose an unused private /16.`);
  return undefined;
}
export function creationDefaults(kind: CreationKind): Record<string, string | number | boolean> {
  return { ...Object.fromEntries(CREATORS[kind].fields.map((field) => [field.key, field.initial])), tags: "{}" };
}
export function defaultImplementationDirectory(kind: CreationKind, id: string, category = "event"): string | undefined {
  if (kind === "function" || kind === "route") return `/lambda_functions/${category === "http" ? "http_functions" : category === "webSocket" ? "websocket_functions" : "event_functions"}/${id}`;
  if (kind === "tool") return `/lambda_functions/tool_functions/${id}`;
  if (kind === "agent") return `/agents/${id}`;
  if (kind === "service" || kind === "task") return `/ecs_containers/${kind === "service" ? "services" : "tasks"}/${id}`;
  return undefined;
}
/** Validate untrusted HTTP input without reflecting submitted values into diagnostics. */
export function readCreationRequest(raw: unknown): CreationRequest {
  const fail = (field: string, message: string): never => { throw new CreationValidationError(field, message); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("kind", "Choose a resource type.");
  const record = raw as Record<string, unknown>;
  if (!CREATION_KINDS.includes(record.kind as CreationKind)) return fail("kind", "Choose a supported resource type.");
  const kind = record.kind as CreationKind;
  const fields = CREATORS[kind].fields;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "tags" && !fields.some((field) => field.key === key))) return fail("kind", "This resource request contains unsupported settings.");
  let tags: DeclarationTags;
  try { tags = validateTags(typeof record.tags === "string" ? JSON.parse(record.tags) : record.tags ?? {}, "tags"); }
  catch (error) { return fail("tags", error instanceof SyntaxError ? "Tags must be a string key/value map." : error instanceof Error ? error.message : String(error)); }
  const result: Record<string, unknown> = { kind, tags };
  for (const field of fields) {
    if (field.key === "tags") continue;
    const value = record[field.key] ?? field.initial;
    if (field.type === "list") {
      const items = typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value;
      if (!Array.isArray(items) || items.length > 50 || items.some((item) => typeof item !== "string" || !item.trim() || item !== item.trim() || item.length > 200) || new Set(items).size !== items.length) return fail(field.key, "Use a list of distinct names (at most 50).");
      result[field.key] = items;
    } else {
      if (typeof value !== typeof field.initial || (typeof value === "string" && (value.length > (field.key === "description" ? 8000 : 500) || /[\0\r\n]/.test(value)))) return fail(field.key, "Enter a valid value for this setting.");
      if (field.options?.length && !field.options.includes(String(value))) return fail(field.key, "Choose one of the supported options.");
      if (field.type === "number" && (!Number.isSafeInteger(value) || (value as number) < 1)) return fail(field.key, "Enter a positive whole number.");
      result[field.key] = value;
    }
  }
  const safeProperty = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(value) && !["constructor", "prototype", "__proto__"].includes(value);
  if (result.directory) {
    const prefix = kind === "agent" ? "/agents/" : kind === "service" || kind === "task" ? "/ecs_containers/" : "/lambda_functions/";
    if (!String(result.directory).startsWith(prefix) || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(String(result.directory))) return fail("directory", `Choose an implementation directory under ${prefix}, without traversal, dots or backslashes.`);
  }
  if ((kind === "input" || kind === "secret" || kind === "stack" ? !safeProperty(result.id) : !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(String(result.id)))) return fail("id", "Enter a safe, unique identifier using the naming convention shown above.");
  if (["input", "secret"].includes(kind)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(String(result.envName))) return fail("envName", "Use an uppercase environment variable name.");
    if (result.group && !safeProperty(result.group)) return fail("group", "Use a TypeScript property name for the group.");
    if (kind === "input" && (result.choices as string[]).length && result.defaultValue && !(result.choices as string[]).includes(String(result.defaultValue))) return fail("defaultValue", "Choose a default from the allowed values.");
    if (kind === "input" && result.defaultValue && !String(result.defaultValue).trim()) return fail("defaultValue", "Enter a non-blank default or leave it empty.");
    if (!!result.consumer !== !!result.consumerVariable || (result.consumerVariable && !/^[A-Z][A-Z0-9_]*$/.test(String(result.consumerVariable)))) return fail("consumerVariable", "Choose a workload and an uppercase environment variable.");
  }
  if (kind === "stack" && !/^[A-Z][A-Za-z0-9]*Stack$/.test(String(result.className))) return fail("className", "Use a PascalCase class name ending in Stack.");
  if ("bindingResource" in result && (!!result.bindingResource !== !!result.bindingVariable || (result.bindingVariable && !/^[A-Z][A-Z0-9_]*$/.test(String(result.bindingVariable))))) return fail("bindingVariable", "A resource binding needs a reference and an uppercase environment variable.");
  if ((kind === "route" || kind === "function") && result.category !== "event") {
    if (result.category === "http" ? !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(String(result.path)) : !/^(?:\$(?:connect|disconnect|default)|[A-Za-z][A-Za-z0-9_-]*)$/.test(String(result.path))) return fail("path", "Enter a literal HTTP path or supported WebSocket route key.");
  }
  if (kind === "service" && !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*(?:\/\*)?$/.test(String(result.path))) return fail("path", "Use a literal mount such as /reports/*.");
  if (kind === "service" && Number(result.port) > 65535) return fail("port", "Use a port from 1 to 65535.");
  if ((kind === "function" || kind === "route") && (Number(result.memory) < 128 || Number(result.memory) > 10240)) return fail("memory", "Lambda memory must be from 128 to 10240 MiB.");
  if ((kind === "function" || kind === "route") && Number(result.timeout) > 900) return fail("timeout", "Lambda timeout cannot exceed 900 seconds.");
  if (kind === "agent" && result.path && (!result.auth || !/^\/[A-Za-z0-9._~/-]+$/.test(String(result.path)))) return fail("path", "Browser routes need authentication and a literal path beginning with /.");
  if (kind === "vpc" && result.zones !== 2 && result.zones !== 3) return fail("zones", "A VPC spans two or three availability zones.");
  if (kind === "vpc") {
    if (String(result.name).length > 100 || /[\x00-\x1f\x7f]/.test(String(result.name)) || (result.name && !String(result.name).trim())) return fail("name", "Use a display name of 1 to 100 printable characters, or leave it empty to use the identifier.");
    result.name = String(result.name).trim();
    const match = /^(10\.(\d{1,3})|172\.(1[6-9]|2\d|3[01])|192\.168)\.0\.0\/16$/.exec(String(result.cidr));
    if (!match || (match[2] !== undefined && Number(match[2]) > 255)) return fail("cidr", 'Use a private /16 such as "10.1.0.0/16".');
  }
  if ((kind === "service" || kind === "task" || ((kind === "function" || kind === "route") && !(kind === "route" && result.existingTarget) && result.subnet !== "none")) && !result.vpc) return fail("vpc", "Select an explicitly declared VPC.");
  if ((kind === "function" || kind === "route") && result.subnet === "none" && result.vpc) return fail("subnet", "Choose private or isolated placement for the selected VPC.");
  // The fields above check every key and primitive; resource compatibility and the
  // framework's own normalization are additionally checked by the batch planner.
  return result as unknown as CreationRequest;
}
