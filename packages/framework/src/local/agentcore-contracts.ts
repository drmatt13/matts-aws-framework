import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getFrameworkTargets, type FrameworkConfig } from "../config/index";
import { resolveLambdaSourcePath } from "../config/source";
import { IDENTITY_ARGUMENT } from "../protocol/agentcore";
import { projectGatewaySchema, type GatewaySchema } from "../protocol/tool-schema";
import type { GatewayToolManifest } from "./agentcore";

/**
 * Reading tool and agent contracts: what a Zod contract module says, as JSON
 * Schema and as the Gateway projection.
 *
 * Two consumers, one reading. `framework:generate` evaluates each contract
 * after proving it imports nothing but Zod, and commits the projection that
 * AWS deploys. The local lane reads the same contracts live, so an edited
 * description or field is what the next tool call lists — the step that makes
 * prompt work on a tool feel like editing code rather than deploying it.
 * `framework:check` keeps the committed projection equal to the source.
 */

/** JSON Schema, as `z.toJSONSchema` returns it. */
export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

export interface ToolContractFacts {
  readonly id: string;
  readonly auth: boolean;
  readonly description: string;
  /** What Gateway lists and the model reads. */
  readonly inputSchema: GatewaySchema;
  readonly outputSchema: GatewaySchema;
  /** The full JSON Schema, for precise generated types. */
  readonly request: JsonSchemaDocument;
  readonly response: JsonSchemaDocument;
}

export interface AgentContractFacts {
  readonly id: string;
  readonly auth: boolean;
  readonly tools: readonly string[];
  readonly streaming: boolean;
  readonly request: JsonSchemaDocument;
  /** The response, or the event a streaming agent yields. */
  readonly result: JsonSchemaDocument;
}

function contractOf(module: Record<string, unknown>, origin: string): Record<string, unknown> {
  const contract = module.contract;
  if (contract === null || typeof contract !== "object") {
    throw new Error(`${origin} contract.ts must export \`contract\`, an object of Zod schemas.`);
  }
  return contract as Record<string, unknown>;
}

function jsonSchema(schema: unknown, io: "input" | "output", origin: string): JsonSchemaDocument {
  try {
    return z.toJSONSchema(schema as z.ZodType, { io, unrepresentable: "throw" }) as JsonSchemaDocument;
  } catch (error) {
    throw new Error(
      `${origin} is not a Zod 4 schema JSON Schema can describe (${error instanceof Error ? error.message : String(error)}). Import z from "zod" at ^4, and avoid transforms whose output has no JSON shape.`,
    );
  }
}

export function readToolContract(
  module: Record<string, unknown>,
  declaration: { readonly id: string; readonly auth: boolean },
): ToolContractFacts {
  const origin = `tools["${declaration.id}"]`;
  const contract = contractOf(module, origin);
  if (typeof contract.description !== "string" || contract.description.trim().length === 0) {
    throw new Error(
      `${origin} contract.description must say what the tool does. The model reads it to decide when to call the tool.`,
    );
  }
  const request = jsonSchema(contract.request, "input", `${origin} contract.request`);
  const response = jsonSchema(contract.response, "output", `${origin} contract.response`);
  const properties = (request as { properties?: Record<string, unknown> }).properties ?? {};
  if (Object.prototype.hasOwnProperty.call(properties, IDENTITY_ARGUMENT)) {
    throw new Error(
      `${origin} contract.request declares ${IDENTITY_ARGUMENT}, which the framework reserves for the signed-in user's token. Rename the field.`,
    );
  }
  return {
    id: declaration.id,
    auth: declaration.auth,
    description: contract.description.trim(),
    inputSchema: projectGatewaySchema(request, `${origin}.request`),
    outputSchema: projectGatewaySchema(response, `${origin}.response`),
    request,
    response,
  };
}

export function readAgentContract(
  module: Record<string, unknown>,
  declaration: { readonly id: string; readonly auth: boolean; readonly tools: readonly string[] },
): AgentContractFacts {
  const origin = `agents["${declaration.id}"]`;
  const contract = contractOf(module, origin);
  const streaming = contract.event !== undefined;
  if (streaming === (contract.response !== undefined)) {
    throw new Error(
      `${origin} contract must declare either response or event: an agent answers once with JSON, or streams events.`,
    );
  }
  return {
    id: declaration.id,
    auth: declaration.auth,
    tools: declaration.tools,
    streaming,
    request: jsonSchema(contract.request, "input", `${origin} contract.request`),
    result: jsonSchema(
      streaming ? contract.event : contract.response,
      "output",
      `${origin} contract.${streaming ? "event" : "response"}`,
    ),
  };
}

/** One evaluated contract per file version, so an unchanged file is not re-imported. */
const loaded = new Map<string, { readonly mtimeMs: number; readonly facts: ToolContractFacts }>();

/**
 * Every tool's contract as the local Gateway lists it, read from source now.
 * A changed file is imported again under a new URL, which is what lets a
 * long-running runner see an edit without restarting.
 */
export async function loadToolManifest(
  config: FrameworkConfig,
  repositoryRoot: string,
): Promise<GatewayToolManifest> {
  const manifest: Record<string, GatewayToolManifest[string]> = {};
  for (const target of getFrameworkTargets(config)) {
    if (target.role !== "tool") continue;
    const file = path.join(resolveLambdaSourcePath(config, target.id, { repositoryRoot }), "contract.ts");
    if (!existsSync(file)) {
      throw new Error(`tools["${target.id}"] needs ${path.relative(repositoryRoot, file)} beside its handler.`);
    }
    const { mtimeMs } = statSync(file);
    const cached = loaded.get(file);
    let facts = cached?.mtimeMs === mtimeMs ? cached.facts : undefined;
    if (!facts) {
      const module = (await import(`${pathToFileURL(file).href}?mtime=${mtimeMs}`)) as Record<string, unknown>;
      facts = readToolContract(module, { id: target.id, auth: config.tools?.[target.id]?.auth === true });
      loaded.set(file, { mtimeMs, facts });
    }
    manifest[target.id] = {
      description: facts.description,
      auth: facts.auth,
      inputSchema: facts.inputSchema,
      outputSchema: facts.outputSchema,
    };
  }
  return manifest;
}
