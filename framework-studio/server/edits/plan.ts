import path from "node:path";
import { sourceDiff as diffOf } from "./diff";
import ts from "typescript";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import type { DiffLine, EditIntent } from "../../shared/api";
import type { FieldFact } from "../../shared/model";
import { parseOrigin, type SemanticPatch } from "../model/origin";
import { entryValue, findEntry, SourceFiles } from "../source";
import { declarationObject, literalValue, propertyAt } from "../source/syntax";
import { sha256, toRelative } from "../files";
import type { FieldDefinition } from "./fields";
import { insertProperty, removeProperty, replaceValue, type LiteralValue } from "./splice";

/**
 * One field change, as a text edit that has been proven to say what it means.
 *
 * A plan is computed entirely in memory. Before it is offered, the new text
 * must parse, the framework's own locator must still find the same entry in
 * it, and the property must read back as exactly the value asked for (or be
 * gone, for "inherit"). Only then is the semantic patch — the same change, in
 * the evaluated config's terms — handed to preflight.
 */

export type { DiffLine, EditIntent };

export interface PlannedEdit {
  readonly file: string;
  readonly relativeFile: string;
  readonly before: string;
  readonly after: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly forward: SemanticPatch;
  readonly summary: string;
  readonly diff: { readonly unified: string; readonly lines: readonly DiffLine[] };
}

export type PlanOutcome = { readonly planned: PlannedEdit } | { readonly refused: string };

function display(value: unknown): string {
  return value === undefined ? "(inherited)" : JSON.stringify(value);
}

/** The value, checked against the field's domain. */
function checkValue(field: FieldDefinition, intent: EditIntent): string | undefined {
  if (intent.inherit && field.required) return `${field.label} is a required baseline default and cannot be removed.`;
  if (intent.inherit) return undefined;
  const value = intent.value;
  if (field.domain.kind === "enum") {
    return value !== undefined && field.domain.values.includes(value)
      ? undefined
      : `${field.label} takes one of ${field.domain.values.join(", ")}.`;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= field.domain.min && value <= field.domain.max
    ? undefined
    : `${field.label} takes a whole number from ${field.domain.min} to ${field.domain.max} ${field.domain.unit}.`;
}

/** Multi-hunk source review shared by every writer. */
export { sourceDiff as diffOf } from "./diff";

/** What the property at `path` reads in `text`, through the framework's locator. */
function readBack(
  repositoryRoot: string,
  file: string,
  text: string,
  origin: string,
  field: FieldDefinition,
  previousFiles?: SourceFiles,
): { readonly value?: LiteralValue; readonly absent?: true } | { readonly error: string } {
  const files = (previousFiles ?? new SourceFiles()).withText(file, text);
  let located;
  try {
    located = locateConfigSource(path.join(repositoryRoot, "framework.config.ts"), { repositoryRoot, host: files.host() });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const parsed = parseOrigin(origin)!;
  const entry = findEntry(located, parsed);
  const value = entry ? entryValue(files, entry) : undefined;
  if (!entry || !value) return { error: `${origin} is no longer found after the edit.` };
  const declaration = declarationObject(value, parsed.section, parsed.chain);
  if ("unsupported" in declaration) return { error: declaration.unsupported };
  const position = propertyAt(declaration.object, field.path);
  if (position.editability.kind === "absent") return { absent: true };
  const written = position.property ? literalValue(position.property.initializer) : undefined;
  return written ? { value: written.value } : { error: `After the edit, ${field.path.join(".")} is not a literal.` };
}

export function planEdit(input: {
  readonly repositoryRoot: string;
  readonly origin: string;
  readonly field: FieldDefinition;
  readonly fact: FieldFact;
  readonly intent: EditIntent;
  readonly files?: SourceFiles;
}): PlanOutcome {
  const { repositoryRoot, origin, field, fact, intent } = input;
  if (fact.blocked) return { refused: fact.blocked };
  const invalid = checkValue(field, intent);
  if (invalid) return { refused: invalid };
  const parsed = parseOrigin(origin);
  if (!parsed) return { refused: `${origin} is not a declaration the studio can change.` };

  const files = input.files ?? new SourceFiles();
  let located;
  try {
    located = locateConfigSource(path.join(repositoryRoot, "framework.config.ts"), { repositoryRoot, host: files.host() });
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
  const entry = findEntry(located, parsed);
  const value = entry ? entryValue(files, entry) : undefined;
  if (!entry || !value) return { refused: `${origin} could not be found in source.` };
  const declaration = declarationObject(value, parsed.section, parsed.chain);
  if ("unsupported" in declaration) return { refused: declaration.unsupported };

  const before = files.text(entry.file);
  const sourceFile = files.get(entry.file);
  const position = propertyAt(declaration.object, field.path);
  const editability = position.editability;

  let after: string;
  try {
    if (editability.kind === "literal" && position.property) {
      after = intent.inherit
        ? removeProperty(before, sourceFile, position.container, position.property)
        : replaceValue(before, sourceFile, position.property, intent.value!);
    } else if (editability.kind === "absent") {
      if (intent.inherit) return { refused: `${field.label} is already inherited.` };
      after = insertProperty(before, sourceFile, position.container, position.missing, intent.value!, field);
    } else if (editability.kind === "computed") {
      return { refused: `${field.label} is computed by \`${editability.text}\`. Change it in your editor.` };
    } else if (editability.kind === "spread") {
      return { refused: `${field.label} may come from \`${editability.text}\`. Change it in your editor.` };
    } else {
      return { refused: editability.kind === "unsupported" ? editability.reason : `${field.label} cannot be changed here.` };
    }
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
  if (after === before) return { refused: `${field.label} already reads ${display(intent.value)}.` };

  const syntax = ts.transpileModule(after, { reportDiagnostics: true, fileName: entry.file }).diagnostics ?? [];
  if (syntax.length > 0) {
    return { refused: `The edit would not parse: ${ts.flattenDiagnosticMessageText(syntax[0]!.messageText, " ")}. Nothing was written.` };
  }
  const readback = readBack(repositoryRoot, entry.file, after, origin, field, files);
  if ("error" in readback) return { refused: `The edit could not be verified: ${readback.error}` };
  if (intent.inherit ? !readback.absent : readback.value !== intent.value) {
    return { refused: `The edit could not be verified: ${field.path.join(".")} reads ${display(readback.value)} afterwards.` };
  }

  const forward: SemanticPatch = intent.inherit
    ? { origin, path: field.path, remove: true }
    : { origin, path: field.path, value: intent.value! };
  const relativeFile = toRelative(repositoryRoot, entry.file);
  return {
    planned: {
      file: entry.file,
      relativeFile,
      before,
      after,
      beforeHash: sha256(before),
      afterHash: sha256(after),
      forward,
      summary: `${field.label}: ${display(fact.authored)} → ${display(intent.inherit ? undefined : intent.value)}`,
      diff: diffOf(relativeFile, before, after),
    },
  };
}
