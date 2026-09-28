import ts from "typescript";

/**
 * Projecting an authored payload contract into the browser package.
 *
 * The contract a handler validates against and the contract a browser validates
 * against have to be the same declaration, and there are only two ways to get
 * that: re-export the authored file across the repository, or copy it. The
 * re-export is what this replaces. It put `cdk-app` source inside the browser's
 * public graph, which meant a contract could reach a handler helper, a Node
 * builtin or another workspace and nothing would notice until something failed
 * downstream — and it flattened every contract into one namespace, where two
 * targets exporting the documented `contract` collide (TS2308).
 *
 * So: one generated module per target, holding the whole authored module —
 * runtime Zod schemas included, because the browser executes them. A contract
 * that only declares types is still supported; it simply has no runtime half.
 *
 * Copying is safe only if what is copied is contained, which is checked here
 * before anything is written. The rules are deliberately narrow rather than a
 * general-purpose dependency copier:
 *
 *   - the only import allowed is `zod`, which the browser package already
 *     depends on;
 *   - no relative import, no other workspace, no Node builtin;
 *   - nothing dynamic — no `import()`, no `require`, no `export * from`.
 *
 * Nothing here executes a contract module. It is read as text and inspected as
 * a syntax tree, so generation cannot be made to run handler code.
 */

/** The one external runtime dependency a contract may declare. */
const ALLOWED_IMPORT = "zod";

function isAllowedSpecifier(specifier: string): boolean {
  return specifier === ALLOWED_IMPORT || specifier.startsWith(`${ALLOWED_IMPORT}/`);
}

export class ContractProjectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContractProjectionError";
  }
}

function positionOf(node: ts.Node, file: ts.SourceFile): string {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return `${line + 1}:${character + 1}`;
}

/**
 * The generated module's file name for a target.
 *
 * Derived from the whole target reference, not from the id: a task and a Lambda
 * may legitimately share a final id, and two targets must never project into
 * one module.
 */
export function contractModuleName(reference: string): string {
  return reference.replace(/:/g, "-");
}

/** A namespace binding is an identifier, so the reference is camel-cased. */
export function contractNamespaceName(reference: string): string {
  const parts = reference.split(/[:\-_]/).filter((part) => part.length > 0);
  return parts
    .map((part, index) =>
      index === 0 ? part : part[0].toUpperCase() + part.slice(1),
    )
    .join("");
}

export interface ContractExport {
  readonly name: string;
  /**
   * Whether the name exists only in the type system.
   *
   * Carried through because the compatibility re-exports have to spell it:
   * `export { SignInRequest }` for a type is erased by `tsc` but survives into
   * a bundler's output as a binding that was never emitted. The browser's
   * schemas are values and its request shapes are types, and the barrel has to
   * say which is which.
   */
  readonly isType: boolean;
}

export interface ContractModuleFacts {
  /** Exported value and type names, in source order. */
  readonly exports: readonly ContractExport[];
}

/**
 * Proves one authored TypeScript contract is contained, and reports what it
 * exports.
 *
 * Throws {@link ContractProjectionError} naming the file, the position and the
 * rule, because this is the diagnostic an author sees when a contract reaches
 * for something the browser cannot have.
 */
export function readContractModule(
  sourceText: string,
  where: string,
): ContractModuleFacts {
  const file = ts.createSourceFile(
    where,
    sourceText,
    ts.ScriptTarget.ES2020,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const exports: ContractExport[] = [];
  // Annotated on the binding, not on the arrow: that is what lets TypeScript
  // treat a call as unreachable and narrow what follows it.
  const reject: (node: ts.Node, problem: string) => never = (node, problem) => {
    throw new ContractProjectionError(
      `${where}:${positionOf(node, file)} ${problem} A payload contract is copied into @repo/api-contract whole, so it may import "${ALLOWED_IMPORT}" and nothing else.`,
    );
  };

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );

  // Dynamic edges hide from the statement walk below, so the whole tree is
  // swept for them rather than only its top level.
  const rejectDynamic = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        reject(node, "uses a dynamic import().");
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        reject(node, "uses require().");
      }
    }
    if (ts.isImportTypeNode(node)) reject(node, "uses an import() type.");
    ts.forEachChild(node, rejectDynamic);
  };
  rejectDynamic(file);

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
      if (!isAllowedSpecifier(specifier)) {
        reject(statement, `imports "${specifier}".`);
      }
      continue;
    }

    if (ts.isImportEqualsDeclaration(statement)) {
      reject(statement, "uses an import-equals declaration.");
    }

    if (ts.isExportAssignment(statement)) {
      reject(
        statement,
        "uses a default or export-assignment export, which has no name to project.",
      );
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier) {
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        reject(statement, `re-exports from "${specifier}".`);
      }
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        reject(statement, "uses a wildcard export.");
      }
      const typeOnlyClause = statement.isTypeOnly;
      for (const element of (statement.exportClause as ts.NamedExports).elements) {
        exports.push({
          name: element.name.text,
          isType: typeOnlyClause || element.isTypeOnly,
        });
      }
      continue;
    }

    if (!isExported(statement)) continue;

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          reject(declaration, "exports a destructured binding, which has no single name.");
        }
        exports.push({ name: declaration.name.text, isType: false });
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (!statement.name || !ts.isIdentifier(statement.name)) {
        reject(statement, "exports a declaration with no plain name.");
      }
      exports.push({
        name: statement.name.text,
        isType:
          ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement),
      });
    }
  }

  return { exports };
}

/** The generated module for one authored TypeScript contract. */
export function typescriptContractModule(options: {
  readonly reference: string;
  /** Repository-relative path of the authored file, for the banner. */
  readonly source: string;
  readonly sourceText: string;
}): string {
  return [
    "/* This file is generated by npm run framework:generate. Do not edit. */",
    "",
    `/* The payload contract for \`${options.reference}\`, copied whole from`,
    ` * ${options.source}`,
    " *",
    " * Edit that file and regenerate. This module is the browser's copy of the",
    " * one authored declaration, not a second place to declare a shape.",
    " */",
    "",
    options.sourceText.trimEnd(),
    "",
  ].join("\n");
}

/** The generated module for one authored JSON Schema contract. */
export function jsonSchemaContractModule(options: {
  readonly reference: string;
  readonly source: string;
  readonly declarations: readonly string[];
}): string {
  return [
    "/* This file is generated by npm run framework:generate. Do not edit. */",
    "",
    `/* The payload contract for \`${options.reference}\`, compiled from`,
    ` * ${options.source}`,
    " *",
    " * A JSON Schema contract declares types only: there is no authored runtime",
    " * validator to project.",
    " */",
    "",
    ...options.declarations.flatMap((declaration) => [declaration.trim(), ""]),
  ].join("\n");
}

export interface ProjectedContract {
  readonly reference: string;
  readonly kind: "typescript" | "json-schema";
  /** Absolute path of the generated module. */
  readonly file: string;
  /** Module specifier the barrel imports it by. */
  readonly specifier: string;
  /** Namespace binding the barrel exposes it under. */
  readonly namespace: string;
  readonly contents: string;
  readonly exports: readonly ContractExport[];
}

/**
 * The public barrel: one namespace per target, plus the flat names.
 *
 * The namespace is the addressable surface and cannot collide — it is derived
 * from the whole target reference, so a task and a Lambda sharing a final id
 * still get separate bindings, and two contracts may both export the documented
 * standard `contract`.
 *
 * The flat re-exports exist for compatibility: every name this package already
 * published keeps working. A name exported by more than one target cannot be
 * flattened, so it is left to the namespaces and reported here rather than
 * silently rebound to whichever target sorted last.
 */
export function contractsBarrel(projected: readonly ProjectedContract[]): string {
  const owners = new Map<string, string[]>();
  for (const contract of projected) {
    for (const { name } of contract.exports) {
      const existing = owners.get(name);
      if (existing) existing.push(contract.reference);
      else owners.set(name, [contract.reference]);
    }
  }
  const isUnique = (name: string) => (owners.get(name) ?? []).length === 1;

  const lines = [
    "/* This file is generated by npm run framework:generate. Do not edit. */",
    "",
    "/**",
    " * Payload contracts, one namespace per target.",
    " *",
    " * Each namespace holds the whole authored contract module for that target,",
    " * runtime schemas included. Address a contract through its namespace —",
    " * `lambdaSignIn.contract` — which is what lets two targets both export the",
    " * documented standard `contract` without colliding.",
    " *",
    " * The flat re-exports below are the compatibility surface: the names this",
    " * package already published, kept working. Only a name belonging to exactly",
    " * one target can appear there.",
    " */",
    "",
  ];

  for (const contract of projected) {
    lines.push(
      `export * as ${contract.namespace} from ${JSON.stringify(contract.specifier)};`,
    );
  }
  if (projected.length > 0) lines.push("");

  // `contract` is the one documented standard name, so it is the one every new
  // contract will claim. It is re-exported flat only while a single target has
  // it, and even then it is deprecated: the namespace is the name that keeps
  // working when a second contract arrives.
  const STANDARD = "contract";
  const collisions: string[] = [];
  for (const contract of projected) {
    const shared = contract.exports.filter(({ name }) => !isUnique(name));
    for (const { name } of shared) {
      const message = `${name} is exported by ${(owners.get(name) ?? []).join(", ")}`;
      if (!collisions.includes(message)) collisions.push(message);
    }

    const flat = contract.exports.filter(
      ({ name }) => isUnique(name) && name !== STANDARD,
    );
    const emit = (keyword: string, names: readonly ContractExport[]) => {
      if (names.length === 0) return;
      lines.push(
        `export ${keyword}{`,
        ...names.map(({ name }) => `  ${name},`),
        `} from ${JSON.stringify(contract.specifier)};`,
        "",
      );
    };
    // Types are spelled `export type`, because a bundler compiling one file at
    // a time cannot tell an erased binding from a missing one.
    emit("", flat.filter(({ isType }) => !isType));
    emit("type ", flat.filter(({ isType }) => isType));

    if (contract.exports.some(({ name }) => name === STANDARD) && isUnique(STANDARD)) {
      lines.push(
        "/**",
        ` * @deprecated Use \`${contract.namespace}.${STANDARD}\`. This unqualified alias`,
        ` * resolves to ${contract.reference} only while it is the single target`,
        " * exporting the standard name; a second one takes it away from both.",
        " */",
        `export { ${STANDARD} } from ${JSON.stringify(contract.specifier)};`,
        "",
      );
    }
  }

  if (collisions.length > 0) {
    lines.push(
      "/**",
      " * Not re-exported flat, because more than one target declares them:",
      ...collisions.map((message) => ` *   - ${message}`),
      " *",
      " * Reach each through its namespace above. Rebinding one of them here",
      " * would hand the name to whichever target happened to sort last.",
      " */",
      "",
    );
  }

  lines.push(
    "/** Browser-safe metadata for targets that expose optional payload contracts. */",
    "export const frameworkContracts = {",
    ...projected.map(
      (contract) =>
        `  ${JSON.stringify(contract.reference)}: { kind: ${JSON.stringify(contract.kind)} },`,
    ),
    "} as const;",
    "",
  );
  return lines.join("\n");
}
