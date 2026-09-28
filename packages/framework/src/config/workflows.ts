/**
 * The workflow vocabulary, as one surface.
 *
 * A workflow is the one framework target with no source directory: the graph
 * *is* the declaration, and every step it runs is another declared target. The
 * pieces live in four modules — {@link ./workflow-ast} for the representation,
 * {@link ./workflow-builder} for the language, {@link ./workflow-normalize} for
 * the graph a backend reads, and {@link ./workflow-semantics} for what any of
 * it means — and this re-exports them under the names the rest of the framework
 * already uses.
 *
 * Browser-safe and free of imports from `./index`, so the target vocabulary can
 * re-export it without a cycle.
 *
 * ## What changed, and why
 *
 * This was previously Amazon States Language with TypeScript types on it:
 * authors wrote `startAt`, a `states` map, per-state `next`, and threaded data
 * through `inputPath`/`resultPath`/`outputPath` by hand. They were doing the
 * compiler's job. Now they write control flow and the framework owns graph
 * construction, state naming, transitions, joins and expression generation.
 *
 * ASL is a compiler target. The TypeScript DSL is the source language.
 */

export * from "./workflow-ast";
export * from "./workflow-builder";
export * from "./workflow-documents";
export * from "./workflow-integrations";
export * from "./workflow-normalize";
export * from "./workflow-validate";

import {
  normalizeWorkflowGraph,
  type CompiledWorkflow,
} from "./workflow-normalize";

/**
 * The one graph both execution lanes read.
 *
 * Kept under its established name: the config layer, the CDK projection and the
 * local runner all speak of a normalized workflow, and only its shape changed.
 */
export type NormalizedWorkflow = CompiledWorkflow;

/** An authored entry as the graph both lanes execute. */
export const normalizeWorkflow = normalizeWorkflowGraph;
