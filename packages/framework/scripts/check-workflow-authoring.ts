import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * What a workflow author cannot do with a symbolic value, checked in source.
 *
 * A workflow value is a *reference*, not a value. `approval.output.approved` is
 * a path recorded during graph construction, and nothing has run yet — so
 * `approval.output.approved ? "yes" : "no"` does not branch on the answer. It
 * evaluates a Proxy, which is truthy, and silently selects `"yes"` every time.
 * The graph is then built with a constant where the author wrote a decision.
 *
 * The type system cannot refuse this: JavaScript coerces anything to a boolean,
 * and a template literal stringifies anything. Nor can the runtime — by the time
 * a workflow runs, the mistake is a literal in the compiled graph and there is
 * nothing left to notice. A syntactic check before anything is built is the only
 * place the mistake is still visible, which is why it lives here.
 *
 * Deliberately syntactic and conservative: it looks at the shape of the code
 * rather than at inferred types, and reports only positions where a symbolic
 * value cannot possibly mean what it reads as.
 */

/** Builders whose result is a flow or a symbolic value. */
const SYMBOLIC_BUILDERS = new Set([
  "invokeLambda",
  "runTask",
  "runWorkflow",
  "sequence",
  "parallel",
  "when",
  "choose",
  "map",
  "retry",
  "attempt",
  "wait",
  "transform",
  "succeed",
  "fail",
  "label",
]);

/** Conversions that would stringify or coerce a reference. */
const COERCING_CALLS = new Set([
  "String",
  "Number",
  "Boolean",
  "JSON.stringify",
  "Object.keys",
  "Object.values",
  "Object.entries",
  "Array.from",
]);

const ARITHMETIC_OR_COMPARISON = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** The supported expression for each refused position. */
const ADVICE: Readonly<Record<string, string>> = {
  condition:
    'Branch with when(condition, ifTrue, ifFalse) or choose(...), and compare with eq(...), gt(...) and the other condition builders. For a value rather than a branch, use expr.ifElse(condition, whenTrue, whenFalse).',
  negation: "Use not(condition) rather than JavaScript's ! on a workflow value.",
  arithmetic:
    "Use expr.add, expr.subtract, expr.multiply or expr.divide, and the condition builders eq/ne/gt/gte/lt/lte for comparisons.",
  logical:
    "Use and(...), or(...) and not(...) for conditions, and expr.coalesce(value, fallback) for a default.",
  template: "Use expr.concat(...) to build a string from workflow values.",
  spread:
    "Use expr.merge(left, right) to combine objects, or name the members you want.",
  await:
    "A workflow step is a declaration, not a promise. Compose steps with sequence(...) and read a result through its .output.",
  coercion:
    "Reshape with expr (add, concat, project, filter, merge) or with transform(...); a workflow value cannot be converted by JavaScript.",
};

export interface WorkflowAuthoringProblem {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly workflow: string;
  readonly message: string;
}

/** Every `.ts` file under a directory, in a stable order. */
function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) found.push(absolute);
    }
  };
  visit(directory);
  return found;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const base = calleeName(expression.expression);
    return base === undefined ? undefined : `${base}.${expression.name.text}`;
  }
  return undefined;
}

/** The workflow a node belongs to, named by the key it is declared under. */
function declaringKey(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isPropertyAssignment(current)) {
      const name = current.name;
      if (ts.isStringLiteral(name) || ts.isIdentifier(name)) return name.text;
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
  }
  return "a workflow";
}

/**
 * One workflow callback, checked.
 *
 * `symbolic` starts as the callback's own `input` binding and grows as the body
 * declares steps, so a reference is recognised by where it came from rather
 * than by guessing from its name.
 */
function checkCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  file: ts.SourceFile,
  problems: WorkflowAuthoringProblem[],
): void {
  const symbolic = new Set<string>();

  const bindParameter = (parameter: ts.ParameterDeclaration): void => {
    const name = parameter.name;
    if (ts.isIdentifier(name)) {
      symbolic.add(name.text);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isIdentifier(element.name)) symbolic.add(element.name.text);
      }
    }
  };
  for (const parameter of callback.parameters) bindParameter(parameter);

  /** Whether an expression is rooted in something symbolic. */
  const isSymbolic = (node: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(node)) return isSymbolic(node.expression);
    if (ts.isNonNullExpression(node)) return isSymbolic(node.expression);
    if (ts.isAsExpression(node)) return isSymbolic(node.expression);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return isSymbolic(node.expression);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === undefined) return false;
      return SYMBOLIC_BUILDERS.has(name) || name.startsWith("expr.");
    }
    if (ts.isIdentifier(node)) return symbolic.has(node.text);
    return false;
  };

  const report = (node: ts.Node, kind: keyof typeof ADVICE, what: string): void => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    problems.push({
      file: file.fileName,
      line: line + 1,
      column: character + 1,
      workflow: declaringKey(node),
      message: `${what} ${ADVICE[kind] as string}`,
    });
  };

  const visit = (node: ts.Node): void => {
    // A step bound to a name is symbolic from here on, including a step whose
    // declaration is itself a nested expression.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isSymbolic(node.initializer)
    ) {
      symbolic.add(node.name.text);
    }

    if (ts.isIfStatement(node) && isSymbolic(node.expression)) {
      report(node.expression, "condition", "A workflow value is used as a JavaScript condition, which is always truthy because nothing has run yet.");
    }
    if (ts.isConditionalExpression(node) && isSymbolic(node.condition)) {
      report(node.condition, "condition", "A workflow value is used as a ternary condition, which always selects the first branch because nothing has run yet.");
    }
    if (
      (ts.isWhileStatement(node) || ts.isDoStatement(node)) &&
      isSymbolic(node.expression)
    ) {
      report(node.expression, "condition", "A workflow value is used as a loop condition, which never becomes false because nothing has run yet.");
    }
    if (ts.isSwitchStatement(node) && isSymbolic(node.expression)) {
      report(node.expression, "condition", "A workflow value is switched on, which compares a reference rather than the value it names.");
    }
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken &&
      isSymbolic(node.operand)
    ) {
      report(node.operand, "negation", "A workflow value is negated with !, which is always false because nothing has run yet.");
    }
    if (ts.isBinaryExpression(node) && ARITHMETIC_OR_COMPARISON.has(node.operatorToken.kind)) {
      if (isSymbolic(node.left) || isSymbolic(node.right)) {
        const logical =
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;
        report(
          node,
          logical ? "logical" : "arithmetic",
          `A workflow value is combined with the JavaScript operator ${node.operatorToken.getText(file)}, which operates on the reference rather than on the value it names.`,
        );
      }
    }
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        if (isSymbolic(span.expression)) {
          report(span.expression, "template", "A workflow value is interpolated into a template literal, which stringifies the reference rather than the value it names.");
        }
      }
    }
    if ((ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) && isSymbolic(node.expression)) {
      report(node.expression, "spread", "A workflow value is spread, which copies nothing because its members do not exist yet.");
    }
    if (ts.isAwaitExpression(node) && isSymbolic(node.expression)) {
      report(node.expression, "await", "A workflow value is awaited.");
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name !== undefined && COERCING_CALLS.has(name)) {
        for (const argument of node.arguments) {
          if (isSymbolic(argument)) {
            report(argument, "coercion", `A workflow value is passed to ${name}(), which reads the reference rather than the value it names.`);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(callback.body, visit);
}

/** Every refusable use of a symbolic value in the declarations under a root. */
export function checkWorkflowAuthoring(
  configDirectory: string,
): readonly WorkflowAuthoringProblem[] {
  const problems: WorkflowAuthoringProblem[] = [];
  if (!statSync(configDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    return problems;
  }

  for (const file of sourceFiles(configDirectory)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("workflow(")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node.expression) === "workflow") {
        const [callback] = node.arguments;
        if (
          callback !== undefined &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          checkCallback(callback, source, problems);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return problems;
}

/** Reports every problem at once, because fixing one at a time is a bad loop. */
export function assertWorkflowAuthoringIsSupported(configDirectory: string): void {
  const problems = checkWorkflowAuthoring(configDirectory);
  if (problems.length === 0) return;
  throw new Error(
    [
      "Workflow declarations use symbolic values in positions JavaScript cannot honour:",
      ...problems.map(
        (problem) =>
          `  ${path.relative(process.cwd(), problem.file).replaceAll("\\", "/")}:${problem.line}:${problem.column} in ${problem.workflow}\n    ${problem.message}`,
      ),
    ].join("\n"),
  );
}
