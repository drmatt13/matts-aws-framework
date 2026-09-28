import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("GraphQL workspace typecheck rejects a Boolean exposed as String", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const directory = resolve(
    root,
    "cdk-app/lambda_functions/http_functions/graphql-api",
  );
  const config = ts.readConfigFile(
    resolve(directory, "tsconfig.json"),
    ts.sys.readFile,
  );
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    directory,
  );
  const target = resolve(directory, "schema/project.ts");
  const host = ts.createCompilerHost(parsed.options);
  const read = host.readFile.bind(host);
  host.readFile = (path) => {
    const content = read(path);
    return resolve(path) === target
      ? content?.replace(
          't.exposeBoolean("archived")',
          't.exposeString("archived")',
        )
      : content;
  };
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        diagnostic.file && resolve(diagnostic.file.fileName) === target,
    );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 2345);
  assert.match(
    ts.flattenDiagnosticMessageText(errors[0].messageText, " "),
    /archived/,
  );
});
