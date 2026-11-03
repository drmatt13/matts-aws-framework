import assert from "./support/assert";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import ts from "typescript";
import {
  AGENT_LAB_FILE,
  AgentLabService,
  agentLabEnvironment,
} from "../server/agent-lab";
import { EditError } from "../server/edits/io";

const original =
  'export const agentLabMessage = "Ready for a reviewed edit.";\n';
const valid = {
  summary: "Update the demo message",
  steps: ["Review the fixed file", "Apply the message"],
  message: "A reviewed message.",
};
type Options = NonNullable<ConstructorParameters<typeof AgentLabService>[1]>;

function fixture(t: TestContext, options: Options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "studio-agent-lab-test-"));
  const file = path.join(root, AGENT_LAB_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, original);
  const service = new AgentLabService(root, {
    plan: async () => valid,
    ...options,
  });
  t.after(async () => {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, service, contents: () => readFileSync(file, "utf8") };
}

const status = (expected: number) => (error: unknown) =>
  error instanceof EditError && error.status === expected;

test("agent planning reads only the fixed source and applying consumes its reviewed plan", async (t) => {
  let received: unknown;
  const item = fixture(t, {
    plan: async (...args) => {
      received = args;
      return valid;
    },
  });
  const unrelated = path.join(item.root, "framework.config.ts");
  writeFileSync(unrelated, "// unrelated configuration\n");
  const plan = await item.service.plan({
    provider: "codex",
    prompt: "Change the demo message",
  });
  assert.deepEqual(received, ["codex", "Change the demo message", original]);
  assert.equal(item.contents(), original, "planning must not edit source");
  assert.equal(plan.before, original);
  assert.equal(
    plan.after,
    `export const agentLabMessage = ${JSON.stringify(valid.message)};\n`,
  );
  assert.match(plan.diff, /agent-lab-message\.ts/);
  assert.deepEqual(item.service.apply({ id: plan.id }), {
    applied: true,
    message: valid.message,
  });
  assert.equal(item.contents(), plan.after);
  assert.equal(readFileSync(unrelated, "utf8"), "// unrelated configuration\n");
  assert.throws(() => item.service.apply({ id: plan.id }), status(409));
});

test("request-controlled paths, code, providers and invalid prompts never reach the planner", async (t) => {
  let calls = 0;
  const item = fixture(t, {
    plan: async () => {
      calls += 1;
      return valid;
    },
  });
  for (const request of [
    null,
    [],
    {},
    { provider: "other", prompt: "hello" },
    { provider: "codex", prompt: " " },
    { provider: "codex", prompt: "x".repeat(2001) },
    { provider: "claude", prompt: 42 },
    { provider: "codex", prompt: "hello", file: "framework.config.ts" },
    { provider: "codex", prompt: "hello", code: "process.exit()" },
  ]) {
    await assert.rejects(item.service.plan(request), status(400));
  }
  assert.equal(calls, 0);
  assert.equal(item.contents(), original);
  const plan = await item.service.plan({ provider: "claude", prompt: "hello" });
  assert.throws(
    () => item.service.apply({ id: plan.id, after: "arbitrary source" }),
    status(400),
  );
  assert.throws(
    () => item.service.apply({ id: "unrecognized-plan" }),
    status(409),
  );
  assert.equal(item.contents(), original);
});

test("invalid model output cannot create an applicable plan", async (t) => {
  const invalid = [
    null,
    [],
    {},
    { ...valid, file: "framework.config.ts" },
    { ...valid, message: "line\nbreak" },
    { ...valid, message: "\u2028" },
    { ...valid, message: "x".repeat(161) },
    { ...valid, message: " " },
    { ...valid, steps: [] },
    { ...valid, steps: [42] },
    { ...valid, summary: "" },
  ];
  for (const result of invalid) {
    const item = fixture(t, { plan: async () => result });
    await assert.rejects(
      item.service.plan({ provider: "codex", prompt: "hello" }),
      (error) =>
        error instanceof EditError && [400, 422].includes(error.status),
    );
    assert.equal(item.contents(), original);
  }
});

test("code-shaped model text remains one string declaration", async (t) => {
  const message = '"; process.exit(1); // ${dangerous} \\ "quoted"';
  const item = fixture(t, { plan: async () => ({ ...valid, message }) });
  const plan = await item.service.plan({
    provider: "claude",
    prompt: "Change the message",
  });
  item.service.apply({ id: plan.id });
  const source = ts.createSourceFile(
    AGENT_LAB_FILE,
    item.contents(),
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(source.statements.length, 1);
  const statement = source.statements[0];
  assert.ok(statement && ts.isVariableStatement(statement));
  const initializer = statement.declarationList.declarations[0]?.initializer;
  assert.ok(initializer && ts.isStringLiteral(initializer));
  assert.equal(initializer.text, message);
});

test("external source changes invalidate a reviewed plan and survive refusal", async (t) => {
  const item = fixture(t);
  const plan = await item.service.plan({ provider: "codex", prompt: "hello" });
  const external = 'export const agentLabMessage = "Changed in an editor.";\n';
  writeFileSync(item.file, external);
  assert.throws(() => item.service.apply({ id: plan.id }), status(409));
  assert.equal(item.contents(), external);
});

test("a source edit while the model is planning refuses its result", async (t) => {
  let finish!: (value: unknown) => void;
  const item = fixture(t, {
    plan: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = item.service.plan({ provider: "codex", prompt: "hello" });
  const external =
    'export const agentLabMessage = "Changed during planning.";\n';
  writeFileSync(item.file, external);
  finish(valid);
  await assert.rejects(pending, status(409));
  assert.equal(item.contents(), external);
});

test("unchanged proposals and results arriving after shutdown cannot create a review", async (t) => {
  const unchanged = fixture(t, {
    plan: async () => ({ ...valid, message: "Ready for a reviewed edit." }),
  });
  await assert.rejects(
    unchanged.service.plan({ provider: "codex", prompt: "hello" }),
    status(422),
  );
  assert.equal(unchanged.contents(), original);
  let finish!: (value: unknown) => void;
  const closed = fixture(t, {
    plan: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = closed.service.plan({ provider: "codex", prompt: "hello" });
  await closed.service.dispose();
  finish(valid);
  await assert.rejects(pending, status(503));
  assert.equal(closed.contents(), original);
});

test("only one planner runs and a failed planner releases the busy state", async (t) => {
  let rejectFirst!: (error: Error) => void;
  let calls = 0;
  const item = fixture(t, {
    plan: () =>
      ++calls === 1
        ? new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve(valid),
  });
  const pending = item.service.plan({ provider: "codex", prompt: "first" });
  await assert.rejects(
    item.service.plan({ provider: "claude", prompt: "second" }),
    status(409),
  );
  assert.equal(calls, 1);
  rejectFirst(new Error("offline planner failure"));
  await assert.rejects(pending, /offline planner failure/);
  const retry = await item.service.plan({
    provider: "claude",
    prompt: "retry",
  });
  assert.equal(retry.provider, "claude");
  assert.equal(item.contents(), original);
});

test("plans expire, are replaced by a new review and disappear on disposal", async (t) => {
  let now = 1_000;
  const item = fixture(t, { now: () => now });
  const first = await item.service.plan({ provider: "codex", prompt: "first" });
  const replacement = await item.service.plan({
    provider: "claude",
    prompt: "replacement",
  });
  assert.throws(() => item.service.apply({ id: first.id }), status(409));
  now = Date.parse(replacement.expiresAt);
  assert.throws(() => item.service.apply({ id: replacement.id }), status(409));
  const last = await item.service.plan({ provider: "codex", prompt: "last" });
  await item.service.dispose();
  assert.throws(() => item.service.apply({ id: last.id }), status(503));
  await assert.rejects(
    item.service.plan({ provider: "codex", prompt: "closed" }),
    status(503),
  );
  assert.equal(item.contents(), original);
});

test("custom code, symlink files, symlink parents and hardlinks refuse the fixed-file writer", async (t) => {
  const custom = fixture(t);
  writeFileSync(custom.file, `${original}throw new Error("custom code");\n`);
  await assert.rejects(
    custom.service.plan({ provider: "codex", prompt: "hello" }),
    status(422),
  );
  assert.equal(
    custom.contents(),
    `${original}throw new Error("custom code");\n`,
  );

  const linkedFile = fixture(t);
  const other = path.join(linkedFile.root, "other.ts");
  writeFileSync(other, original);
  rmSync(linkedFile.file);
  symlinkSync(other, linkedFile.file);
  await assert.rejects(
    linkedFile.service.plan({ provider: "codex", prompt: "hello" }),
    status(422),
  );
  assert.equal(readFileSync(other, "utf8"), original);

  const linkedParent = fixture(t);
  const originalDirectory = path.join(
    linkedParent.root,
    "framework-studio/src",
  );
  const otherDirectory = path.join(linkedParent.root, "outside");
  mkdirSync(otherDirectory);
  writeFileSync(path.join(otherDirectory, "agent-lab-message.ts"), original);
  rmSync(originalDirectory, { recursive: true });
  symlinkSync(otherDirectory, originalDirectory);
  await assert.rejects(
    linkedParent.service.plan({ provider: "codex", prompt: "hello" }),
    status(422),
  );

  const hardlink = fixture(t);
  linkSync(hardlink.file, path.join(hardlink.root, "another-name.ts"));
  await assert.rejects(
    hardlink.service.plan({ provider: "codex", prompt: "hello" }),
    status(422),
  );
});

test("CLI children receive a small environment without application or API credentials", () => {
  const names = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DATABASE_URL",
  ];
  const previous = names.map((name) => process.env[name]);
  try {
    for (const name of names) process.env[name] = "agent-lab-test-sentinel";
    const environment = agentLabEnvironment();
    for (const name of names) assert.equal(environment[name], undefined);
    assert.equal(environment.HOME, process.env.HOME);
    assert.equal(environment.PATH, process.env.PATH);
  } finally {
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

interface CliCall {
  provider: string;
  args: string[];
  cwd: string;
  requestedCwd: string;
  files: string[];
  environment: Record<string, string | undefined>;
  credentialNames: string[];
}

/** Exercise the real spawn/parse adapter using local scripts, never a model or real login. */
function fakeClis(
  t: TestContext,
  output: { stdout?: string; stderr?: string; code?: number } = {},
) {
  const item = fixture(t, { plan: undefined });
  const bin = path.join(item.root, "bin"),
    home = path.join(item.root, "safe-home"),
    log = path.join(item.root, "cli-calls.jsonl");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(log, "");
  const keys = [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "AWS_ACCESS_KEY_ID",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DATABASE_URL",
  ];
  const previous = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }),
  );
  Object.assign(process.env, {
    PATH: bin,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    AWS_ACCESS_KEY_ID: "fake-cli-test-sentinel",
    OPENAI_API_KEY: "fake-cli-test-sentinel",
    ANTHROPIC_API_KEY: "fake-cli-test-sentinel",
    DATABASE_URL: "fake-cli-test-sentinel",
  });
  const events = [
    {
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(valid) },
    },
    { type: "turn.completed" },
  ];
  const stdout =
    output.stdout ??
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  for (const provider of ["codex", "claude"]) {
    const file = path.join(bin, provider);
    writeFileSync(
      file,
      `#!${process.execPath}\n
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  provider: ${JSON.stringify(provider)}, args, cwd: process.cwd(), files: fs.readdirSync(process.cwd()),
  requestedCwd: args.includes("-C") ? fs.realpathSync(args[args.indexOf("-C") + 1]) : process.cwd(),
  environment: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
  credentialNames: ["AWS_ACCESS_KEY_ID", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL"].filter(key => process.env[key] !== undefined)
}) + "\\n");
if (${JSON.stringify(provider)} === "claude") {
  process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: "none" })); process.exit(1);
}
if (args[0] === "login" && args[1] === "status") {
  process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0);
}
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(output.stderr ?? "")});
process.exit(${output.code ?? 0});
`,
    );
    chmodSync(file, 0o700);
  }
  return {
    ...item,
    bin,
    home,
    calls: (): CliCall[] =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

test(
  "the Codex adapter invokes a read-only isolated CLI with sanitized credentials",
  {
    skip:
      process.platform === "win32"
        ? "Node shebang fake executable requires POSIX"
        : false,
  },
  async (t) => {
    const item = fakeClis(t);
    const plan = await item.service.plan({
      provider: "codex",
      prompt: "Update the demo only",
    });
    assert.equal(plan.message, valid.message);
    assert.equal(
      item.contents(),
      original,
      "a successful native planner must still leave source untouched",
    );
    const calls = item.calls();
    const execution = calls.find(
      (call) => call.provider === "codex" && call.args.includes("exec"),
    );
    assert.ok(execution);
    assert.equal(
      execution.args[execution.args.indexOf("--sandbox") + 1],
      "read-only",
    );
    assert.equal(execution.args[execution.args.indexOf("-a") + 1], "never");
    for (const flag of [
      "--ignore-user-config",
      "--ephemeral",
      "--json",
      "--output-schema",
    ])
      assert.ok(execution.args.includes(flag), flag);
    for (const feature of [
      "shell_tool",
      "hooks",
      "multi_agent",
      "apps",
      "plugins",
      "remote_plugin",
    ]) {
      assert.ok(
        execution.args.some(
          (arg, index) =>
            arg === "--disable" && execution.args[index + 1] === feature,
        ),
        feature,
      );
    }
    assert.ok(execution.args.includes('web_search="disabled"'));
    assert.equal(execution.requestedCwd, execution.cwd);
    assert.equal(
      existsSync(execution.cwd),
      false,
      "the disposable agent directory must be cleaned after planning",
    );
    assert.ok(
      path.relative(item.root, execution.cwd).startsWith(".."),
      "agent cwd must be outside the repository",
    );
    assert.deepEqual(execution.files, ["proposal-schema.json"]);
    for (const call of calls) {
      assert.deepEqual(call.credentialNames, []);
      assert.equal(call.environment.HOME, item.home);
      assert.equal(call.environment.PATH, item.bin);
    }
  },
);

test(
  "malformed and failed CLI output returns bounded errors without raw diagnostics",
  {
    skip:
      process.platform === "win32"
        ? "Node shebang fake executable requires POSIX"
        : false,
  },
  async (t) => {
    for (const output of [
      {
        stdout: "sensitive-machine-diagnostic-not-json",
        stderr: "private-account-details",
      },
      {
        stdout: "private-account-details",
        stderr: "sensitive-machine-diagnostic",
        code: 7,
      },
    ]) {
      await t.test(
        output.code ? "nonzero CLI exit" : "invalid JSON",
        async (subtest) => {
          const item = fakeClis(subtest, output);
          await assert.rejects(
            item.service.plan({ provider: "codex", prompt: "hello" }),
            (error) => {
              assert.ok(error instanceof EditError);
              assert.equal(error.status, 502);
              assert.doesNotMatch(
                error.message,
                /private-account|sensitive-machine/,
              );
              assert.match(error.message, /No source was changed/);
              return true;
            },
          );
          assert.equal(item.contents(), original);
        },
      );
    }
  },
);

test(
  "an installed unauthenticated Claude CLI is reported unavailable and never asked to generate",
  {
    skip:
      process.platform === "win32"
        ? "Node shebang fake executable requires POSIX"
        : false,
  },
  async (t) => {
    const item = fakeClis(t);
    const availability = await item.service.status();
    assert.equal(
      availability.providers.find((provider) => provider.id === "codex")
        ?.available,
      true,
    );
    assert.equal(
      availability.providers.find((provider) => provider.id === "claude")
        ?.available,
      false,
    );
    await assert.rejects(
      item.service.plan({ provider: "claude", prompt: "hello" }),
      status(422),
    );
    assert.ok(
      item
        .calls()
        .filter((call) => call.provider === "claude")
        .every((call) => call.args.join(" ") === "auth status"),
    );
    assert.ok(
      item
        .calls()
        .filter((call) => call.provider === "codex")
        .every((call) => call.args.join(" ") === "login status"),
    );
    assert.equal(item.contents(), original);
  },
);
