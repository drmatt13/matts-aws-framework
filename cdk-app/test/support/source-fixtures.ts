import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findRepositoryRoot } from "@repo/framework/config/source";

/**
 * Handler directories a test writes for itself and removes afterwards.
 *
 * Kept under `.cache` — in cdk-app for a tool, under agents for an agent, the
 * two roots a declaration may name — never beside the real handlers. Tests that
 * synthesize a service or a task stage the repository root as its Docker build
 * context while this file's tests run in parallel, and `.dockerignore` and
 * `.gitignore` both exclude `**\/.cache`: a fixture appearing or vanishing
 * mid-copy can neither fail that copy nor be left behind as an undeclared
 * handler when a run is killed.
 */

const root = findRepositoryRoot(__dirname);

/** The framework path, rooted at cdk-app, of a fixture tool in this run. */
export function toolFixtureDirectory(run: string, id: string): `/${string}` {
  return `/.cache/test-fixtures/${run}/${id}`;
}

/** The framework path of a fixture agent in this run. */
export function agentFixtureDirectory(run: string, id: string): `/agents/${string}` {
  return `/agents/.cache/test-fixtures/${run}/${id}`;
}

/** Writes each fixture's index.ts; the answer removes the run's directories. */
export function writeSourceFixtures(
  run: string,
  sources: { readonly tools?: Readonly<Record<string, string>>; readonly agents?: Readonly<Record<string, string>> },
): () => void {
  const write = (directory: string, source: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "index.ts"), source);
  };
  for (const [id, source] of Object.entries(sources.tools ?? {})) {
    write(path.join(root, "cdk-app", toolFixtureDirectory(run, id).slice(1)), source);
  }
  for (const [id, source] of Object.entries(sources.agents ?? {})) {
    write(path.join(root, agentFixtureDirectory(run, id).slice(1)), source);
  }
  return () => {
    for (const directory of [path.join(root, "cdk-app/.cache/test-fixtures", run), path.join(root, "agents/.cache/test-fixtures", run)]) {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** The smallest sources a tool and an agent fixture need. */
export const fixtureToolSource = "export const lambdaHandler = async () => ({});";
export const fixtureAgentSource = (id: string) => `export const handler = { kind: "framework-agent", id: ${JSON.stringify(id)} };`;
