import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The static half of route-key validation.
 *
 * Route maps are validated by their keys, and a spread can overwrite a key
 * before any runtime validator sees it — `{ ...a, ...b }` silently keeps one
 * declaration and drops the other. TypeScript catches a repeated literal key
 * within one object; only reading the source catches the rest, so the check
 * lives here rather than pretending a runtime validator could recover what was
 * already lost.
 *
 * Sections compose as an array of modules, so this reads the config and then one
 * hop further into each module it names. That is also what lets it report the
 * case `defineFrameworkConfig` can only describe by position: the same key
 * declared in two files, named by file.
 */

/** Sections whose keys are an identity — a route, a route key, or a target id. */
const CHECKED_SECTIONS = [
  "http",
  "webSocket",
  "events",
  "services",
  "tasks",
  "workflows",
  "tools",
  "agents",
] as const;

export type CheckedSection = (typeof CHECKED_SECTIONS)[number];

/** The keys each section declares, in the order the source declares them. */
export type SectionKeys = Readonly<Record<CheckedSection, readonly string[]>>;

/** File access, injectable so the checker can be tested without a repository. */
export interface ConfigSourceHost {
  readonly readFile: (file: string) => string;
  readonly exists: (file: string) => boolean;
}

const nodeHost: ConfigSourceHost = {
  readFile: (file) => readFileSync(file, "utf8"),
  exists: (file) => existsSync(file),
};

export interface AssertSectionModulesOptions {
  /** Root that file names in messages are reported relative to. */
  readonly repositoryRoot?: string;
  readonly host?: ConfigSourceHost;
}

/** Strips the wrappers an authored section is allowed to carry. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else return current;
  }
}

/** A section expression together with the file it was written in. */
interface Located {
  readonly file: string;
  readonly expression: ts.Expression;
}

class ConfigSource {
  private readonly parsed = new Map<string, ts.SourceFile>();

  constructor(
    private readonly host: ConfigSourceHost,
    private readonly repositoryRoot: string,
  ) {}

  /** A path as it should read in a message: relative to the root, forward slashes. */
  name(file: string): string {
    return path.relative(this.repositoryRoot, file).replaceAll("\\", "/");
  }

  parse(file: string): ts.SourceFile {
    const cached = this.parsed.get(file);
    if (cached) return cached;
    const sourceFile = ts.createSourceFile(
      file,
      this.host.readFile(file),
      ts.ScriptTarget.Latest,
      true,
    );
    this.parsed.set(file, sourceFile);
    return sourceFile;
  }

  /** A top-level const, exported or not, by the name it is bound to. */
  private declaration(file: string, name: string): ts.Expression | undefined {
    let found: ts.Expression | undefined;
    ts.forEachChild(this.parse(file), (statement) => {
      if (!ts.isVariableStatement(statement)) return;
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer
        ) {
          found = unwrap(declaration.initializer);
        }
      }
    });
    return found;
  }

  /** The module and original export an imported name is bound to. */
  private importBinding(
    file: string,
    name: string,
  ): { readonly specifier: string; readonly exported: string } | undefined {
    let found: { specifier: string; exported: string } | undefined;
    ts.forEachChild(this.parse(file), (statement) => {
      if (!ts.isImportDeclaration(statement)) return;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
      for (const element of bindings.elements) {
        if (element.name.text !== name) continue;
        found = {
          specifier: statement.moduleSpecifier.text,
          exported: element.propertyName?.text ?? element.name.text,
        };
      }
    });
    return found;
  }

  /** A relative specifier as a file on disk. */
  private moduleFile(from: string, specifier: string): string | undefined {
    const base = path.resolve(path.dirname(from), specifier);
    const candidates = [
      base.replace(/\.js$/, ".ts"),
      `${base}.ts`,
      path.join(base, "index.ts"),
    ];
    return candidates.find((candidate) => this.host.exists(candidate));
  }

  /**
   * Follows an identifier to the expression it names, in this file or one hop
   * into the module it is imported from. Returns the problem when it cannot.
   */
  resolve(located: Located): Located | string {
    const expression = unwrap(located.expression);
    if (!ts.isIdentifier(expression)) return { ...located, expression };

    const local = this.declaration(located.file, expression.text);
    if (local) return { file: located.file, expression: local };

    const binding = this.importBinding(located.file, expression.text);
    if (!binding) {
      return `${this.name(located.file)} names "${expression.text}", which is neither declared nor imported there.`;
    }
    if (!binding.specifier.startsWith(".")) {
      return `${this.name(located.file)} imports "${expression.text}" from "${binding.specifier}". A section module must be a relative import inside the repository, so its keys can be read.`;
    }
    const file = this.moduleFile(located.file, binding.specifier);
    if (!file) {
      return `${this.name(located.file)} imports "${expression.text}" from "${binding.specifier}", which does not resolve to a TypeScript file.`;
    }
    const declaration = this.declaration(file, binding.exported);
    if (!declaration) {
      return `${this.name(file)} does not declare a const "${binding.exported}". A section module must declare its map as an exported const object literal.`;
    }
    return { file, expression: declaration };
  }
}

/** A property's key as written, or undefined when it is not a literal. */
function literalKey(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

/**
 * Fails when a section's keys cannot be read from the source, or when two
 * modules composed into one section declare the same key.
 */
export function assertSectionModulesAreLiteral(
  configFile: string,
  options: AssertSectionModulesOptions = {},
): void {
  readSectionKeys(configFile, options);
}

/**
 * The same pass, returning what it read.
 *
 * A workflow has no source directory, so its id cannot come from a filesystem
 * scan the way a task's or a handler's does. It comes from here instead: the
 * literal `workflows` keys, read statically, *before* the config is imported —
 * which is the only order that works, because `framework.config.ts` is typed
 * against the generated union it would be producing.
 *
 * Reading rather than executing is also what keeps this safe to run first: no
 * section module is evaluated, no graph helper runs, and a config that would
 * throw on import still yields the ids needed to type it.
 */
export function readSectionKeys(
  configFile: string,
  options: AssertSectionModulesOptions = {},
): SectionKeys {
  const host = options.host ?? nodeHost;
  const repositoryRoot = options.repositoryRoot ?? path.dirname(configFile);
  const source = new ConfigSource(host, repositoryRoot);
  const problems: string[] = [];
  const keys: Record<CheckedSection, string[]> = {
    http: [], webSocket: [], events: [], services: [], tasks: [], workflows: [], tools: [], agents: [],
  };

  /** Every module composed into one section, flattening the array literal. */
  const modulesOf = (section: string, node: ts.Expression): Located[] => {
    const expression = unwrap(node);
    if (!ts.isArrayLiteralExpression(expression)) {
      return [{ file: configFile, expression: node }];
    }

    const modules: Located[] = [];
    for (const element of expression.elements) {
      if (!ts.isSpreadElement(element)) {
        modules.push({ file: configFile, expression: element });
        continue;
      }
      // Spreading an array is safe where spreading a map is not: it
      // concatenates instead of overwriting, so it is followed, not rejected.
      const resolved = source.resolve({
        file: configFile,
        expression: element.expression,
      });
      if (typeof resolved === "string") {
        problems.push(resolved);
        continue;
      }
      const group = unwrap(resolved.expression);
      if (!ts.isArrayLiteralExpression(group)) {
        problems.push(
          `${section} spreads "${element.expression.getText()}", which is not an array literal of section modules. Spread only an array, or list each module.`,
        );
        continue;
      }
      for (const inner of group.elements) {
        modules.push({ file: resolved.file, expression: inner });
      }
    }
    return modules;
  };

  const check = (section: string, node: ts.Expression): void => {
    // Where each key was declared, so a collision can name both modules.
    const declaredIn = new Map<string, string>();

    for (const module of modulesOf(section, node)) {
      const resolved = source.resolve(module);
      if (typeof resolved === "string") {
        problems.push(resolved);
        continue;
      }
      const literal = unwrap(resolved.expression);
      if (!ts.isObjectLiteralExpression(literal)) {
        problems.push(
          `${section} is composed from ${source.name(resolved.file)}, which does not declare it as an object literal, so its keys cannot be checked.`,
        );
        continue;
      }

      const file = source.name(resolved.file);
      for (const property of literal.properties) {
        if (ts.isSpreadAssignment(property)) {
          problems.push(
            `${section} composes keys with a spread in ${file}. A later spread can overwrite a key before validation sees it, so declare every entry literally and compose the modules as an array.`,
          );
          continue;
        }
        const key = literalKey(property);
        if (key === undefined) {
          problems.push(
            `${section} uses a computed key in ${file}. Keys must be literal so conflicts are detectable.`,
          );
          continue;
        }
        const first = declaredIn.get(key);
        if (first !== undefined) {
          problems.push(
            `${section} declares "${key}" in both ${first} and ${file}. A key may be declared by one module only.`,
          );
          continue;
        }
        declaredIn.set(key, file);
        keys[section as CheckedSection]?.push(key);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineFrameworkConfig" &&
      node.arguments[0]
    ) {
      const resolved = source.resolve({
        file: configFile,
        expression: node.arguments[0],
      });
      if (typeof resolved === "string") {
        problems.push(resolved);
      } else {
        const argument = unwrap(resolved.expression);
        if (ts.isObjectLiteralExpression(argument)) {
          for (const property of argument.properties) {
            if (ts.isSpreadAssignment(property)) {
              problems.push(
                "defineFrameworkConfig composes its sections with a spread. Pass each section explicitly.",
              );
              continue;
            }
            const name = literalKey(property);
            if (
              name === undefined ||
              !(CHECKED_SECTIONS as readonly string[]).includes(name)
            ) {
              continue;
            }
            if (ts.isPropertyAssignment(property)) {
              check(name, property.initializer);
            } else if (ts.isShorthandPropertyAssignment(property)) {
              check(name, property.name);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source.parse(configFile));

  if (problems.length > 0) {
    throw new Error(
      `${source.name(configFile)} sections must be literal:\n  - ${problems.join("\n  - ")}`,
    );
  }

  return keys;
}
