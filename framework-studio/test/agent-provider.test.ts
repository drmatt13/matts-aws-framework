import assert from "./support/assert";
import { test, type TestContext } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexArguments, executionPolicy, providerEnvironment, tomlValue } from "../server/agent-runtime/policy";
import { JsonLinesProcess } from "../server/agent-runtime/providers/transport";
import { CodexConnection, runCodex } from "../server/agent-runtime/providers/codex";
import type { ProviderEvent } from "../server/agent-runtime/providers/types";
import { claudePermissionAllowed, runClaude } from "../server/agent-runtime/providers/claude";
import { installedNpm, parseMachImage } from "../server/agent-runtime/providers/toolchain";
import { frameworkValidationCommands, resolveValidationCommand } from "../server/agent-runtime/providers/validation";
import { STUDIO_SHELL_TOOL, studioShellMessage } from "../server/agent-runtime/providers/claude-shell";
import { runProvider } from "../server/agent-runtime/providers";
import { commandSummary, emitText } from "../server/agent-runtime/providers/events";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "studio-provider-test-"));
  const cwd = path.join(root, "candidate"), scratch = path.join(root, "scratch");
  mkdirSync(cwd); mkdirSync(scratch);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cwd, scratch };
}

test("provider dispatch reaches both audited adapters and respects cancellation before setup", async t => {
  const { cwd, scratch } = fixture(t), policy = executionPolicy(cwd, scratch), called: string[] = [];
  for (const provider of ["codex", "claude"] as const) {
    const result = await runProvider({ provider, cwd, scratchDir: scratch, prompt: "repair", signal: new AbortController().signal, onEvent: () => {} }, {
      policy: () => policy,
      codex: async (_options, assigned) => { assert.equal(assigned, policy); called.push("codex"); return { status: "completed" }; },
      claude: async (_options, assigned) => { assert.equal(assigned, policy); called.push("claude"); return { status: "completed" }; },
    });
    assert.equal(result.status, "completed");
  }
  assert.deepEqual(called, ["codex", "claude"]);
  const controller = new AbortController(); controller.abort();
  assert.equal((await runProvider({ provider: "claude", cwd, prompt: "repair", signal: controller.signal, onEvent: () => {} }, { policy: () => { throw new Error("must not initialize"); } })).status, "cancelled");
});

test("provider authentication stays native while task secrets and Node injection are removed", () => {
  const env = providerEnvironment("/scratch", { HOME: "/user", USER: "matt", CODEX_HOME: "/codex", CLAUDE_CONFIG_DIR: "/claude", PATH: "/bin",
    AWS_ACCESS_KEY_ID: "secret", ANTHROPIC_API_KEY: "secret", NODE_OPTIONS: "--require /evil", DATABASE_URL: "secret", SSH_AUTH_SOCK: "/socket" });
  assert.equal(env.HOME, "/user"); assert.equal(env.USER, "matt");
  assert.equal(env.CODEX_HOME, "/codex"); assert.equal(env.CLAUDE_CONFIG_DIR, "/claude");
  for (const key of ["AWS_ACCESS_KEY_ID", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "DATABASE_URL", "SSH_AUTH_SOCK"]) assert.equal(env[key], undefined);
  assert.equal(env.TMPDIR, "/scratch");
});

test("execution policy grants only candidate/scratch writes with a unique profile", t => {
  const { cwd, scratch } = fixture(t);
  const p = executionPolicy(cwd, scratch), q = executionPolicy(cwd, scratch);
  assert.notEqual(p.profile, q.profile);
  const profile = (p.config.permissions as any)[p.profile];
  assert.deepEqual(profile.network, { enabled: false });
  assert.equal(profile.filesystem[p.cwd], "write");
  assert.equal(profile.filesystem[path.join(p.cwd, ".codex")], "deny");
  assert.equal(p.config.approval_policy, "never");
  const args = codexArguments(p);
  for (const feature of ["multi_agent", "multi_agent_v2", "multi_agent_v2_dynamic_tools", "enable_mcp_apps", "in_app_browser", "browser_use_external", "browser_use_full_cdp_access"]) {
    const at = args.indexOf(feature); assert.ok(at > 0); assert.equal(args[at - 1], "--disable");
  }
  assert.throws(() => executionPolicy(cwd, path.join(cwd, "scratch")), /outside/);
  assert.equal(tomlValue({ "quoted.key": ["a\nb", true] }), '{"quoted.key"=["a\\nb",true]}');
});

test("preview policy preserves read-only candidate and narrowly grants a pinned closure", t => {
  const { root, cwd, scratch } = fixture(t); const runtime = path.join(root, "pinned-runtime"); mkdirSync(runtime);
  const p = executionPolicy(cwd, scratch, { readOnlyCwd: true, readPaths: [runtime] });
  const fs = (p.config.permissions as any)[p.profile].filesystem;
  assert.equal(fs[p.cwd], "read"); assert.equal(fs[p.scratchDir], "write"); assert.equal(fs[realpathSync(runtime)], "read");
  assert.throws(() => executionPolicy(cwd, scratch, { readPaths: ["/"] }), /Broad/);
});

test("trusted Node library metadata and npm resolution avoid live project dependencies", () => {
  assert.deepEqual(parseMachImage("node:\n\t@rpath/libnode.dylib (compatibility version 1.0.0, current version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)", "Load command 1\n cmd LC_RPATH\n cmdsize 40\n path @loader_path/../lib (offset 12)\n"),
    { libraries: ["@rpath/libnode.dylib", "/usr/lib/libSystem.B.dylib"], rpaths: ["@loader_path/../lib"] });
  const npm = installedNpm(), command = resolveValidationCommand({ file: "npm", args: ["run", "verify"] });
  assert.equal(command.file, process.execPath); assert.deepEqual(command.args, [npm.entry, "run", "verify"]);
  assert.ok(!npm.directory.startsWith(process.cwd() + path.sep));
  assert.throws(() => resolveValidationCommand({ file: "sh", args: [] }), /only/);
});

test("known framework checks use the Node loader without dropping npm hooks or custom script steps", t => {
  const { cwd } = fixture(t), directory = path.join(cwd, "packages/framework/scripts"); mkdirSync(directory, { recursive: true });
  const scripts = { "framework:check": "tsx packages/framework/scripts/generate-contracts.ts --check && tsx packages/framework/scripts/check-local.ts" };
  assert.equal(frameworkValidationCommands(scripts, cwd), undefined);
  writeFileSync(path.join(directory, "generate-contracts.ts"), "// fixture\n"); writeFileSync(path.join(directory, "check-local.ts"), "// fixture\n");
  assert.deepEqual(frameworkValidationCommands(scripts, cwd), [
    { file: "node", args: ["--import", "tsx", "packages/framework/scripts/generate-contracts.ts", "--check"] },
    { file: "node", args: ["--import", "tsx", "packages/framework/scripts/check-local.ts"] },
  ]);
  for (const other of [undefined, {}, { "framework:check": scripts["framework:check"] + " && node extra.cjs" },
    { ...scripts, "preframework:check": "node prepare.cjs" }, { ...scripts, "postframework:check": "node assert.cjs" }]) {
    assert.equal(frameworkValidationCommands(other, cwd), undefined);
  }
  rmSync(path.join(directory, "check-local.ts")); symlinkSync(path.join(directory, "generate-contracts.ts"), path.join(directory, "check-local.ts"));
  assert.equal(frameworkValidationCommands(scripts, cwd), undefined);
});

test("Claude exposes only the fixed restricted shell and no native file or process tools", t => {
  const { root, cwd, scratch } = fixture(t), policy = executionPolicy(cwd, scratch);
  const target = path.join(root, "private.txt"); writeFileSync(target, "sentinel"); symlinkSync(target, path.join(cwd, "linked"));
  assert.equal(claudePermissionAllowed(policy, STUDIO_SHELL_TOOL, { command: "node --test" }), true);
  assert.equal(claudePermissionAllowed(policy, "Write", { file_path: path.join(policy.cwd, "source.ts") }), false);
  for (const file_path of [target, path.join(cwd, "linked"), path.join(cwd, ".codex/config.toml")]) assert.equal(claudePermissionAllowed(policy, "Read", { file_path }), false);
  assert.equal(claudePermissionAllowed(policy, "Bash", { command: "node --test", dangerouslyDisableSandbox: true }), false);
  assert.equal(claudePermissionAllowed(policy, STUDIO_SHELL_TOOL, { command: "node --test", cwd: "/" }), false);
  assert.equal(claudePermissionAllowed(policy, "WebFetch", { url: "https://example.com" }), false);
});

function fakeClaude(t: TestContext) {
  const f = fixture(t), bin = path.join(f.root, "bin"); mkdirSync(bin);
  const fake = path.join(bin, "claude"), responses = path.join(f.root, "responses.jsonl"), calls = path.join(f.root, "calls.jsonl"), launch = path.join(f.root, "launch.json");
  const script = [
    "#!" + process.execPath,
    "const rl=require('node:readline'),fs=require('node:fs');let turn=0;const session=process.argv.find(x=>x.startsWith('--resume='))?.slice(9)||'claude-saved';",
    "fs.writeFileSync(" + JSON.stringify(launch) + ",JSON.stringify(process.argv));",
    "const tool='mcp__studio_shell__run';const out=m=>console.log(JSON.stringify(m));const permission=(id,tool,input)=>out({type:'control_request',request_id:id,request:{subtype:'can_use_tool',tool_name:tool,input}});const call=(id,command)=>out({type:'control_request',request_id:id,request:{subtype:'mcp_message',server_name:'studio_shell',message:{jsonrpc:'2.0',id,method:'tools/call',params:{name:'run',arguments:{command}}}}});",
    "rl.createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(" + JSON.stringify(calls) + ",line+'\\n');const m=JSON.parse(line);",
    "if(m.type==='control_request'&&m.request.subtype==='initialize'){out({type:'control_response',response:{request_id:'initialize',subtype:'success'}});}",
    "else if(m.type==='user'){turn++;if(turn===1){out({type:'system',subtype:'init',session_id:session,tools:[tool]});out({type:'assistant',message:{content:[{type:'tool_use',id:'probe-tool',name:tool,input:{command:'trusted probe'}}]}});permission('probe',tool,{command:'trusted probe'});}else{out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Investigating source'}}});permission('outside','Read',{file_path:" + JSON.stringify(path.join(f.root, "private.txt")) + "});}}",
    "else if(m.type==='control_response'){fs.appendFileSync(" + JSON.stringify(responses) + ",line+'\\n');const id=m.response.request_id;if(id==='probe')call('probe-exec','trusted probe');else if(id==='probe-exec'){out({type:'user',message:{content:[{type:'tool_result',tool_use_id:'probe-tool',content:'probe passed'}]}});out({type:'result',subtype:'success',is_error:false});}else if(id==='outside')permission('bypass','Bash',{command:'unsafe',dangerouslyDisableSandbox:true});else if(id==='bypass')permission('safe',tool,{command:'node --test'});else if(id==='safe')call('safe-exec','node --test');else if(id==='safe-exec')out({type:'result',subtype:'success',is_error:false});}",
    "});",
  ].join("\n");
  writeFileSync(fake, script); chmodSync(fake, 0o700);
  const policy = executionPolicy(f.cwd, f.scratch); policy.environment.PATH = bin;
  let checked = false, disposed = false; const commands: string[] = [];
  const dependency = { fixture: async () => ({ command: ["trusted", "probe"], shellCommand: "trusted probe", sentinelPath: "/disposable",
    assert: () => { checked = true; }, dispose: async () => { disposed = true; } }), shell: { execute: async (command: string) => { commands.push(command); return { exitCode: 0, stdout: "passed", stderr: "" }; }, close: async () => {} } };
  return { ...f, policy, responses, calls, launch, dependency, commands, checks: () => ({ checked, disposed }) };
}

test("Claude streams with automatic fixed-boundary permission and denies other capabilities", async t => {
  const f = fakeClaude(t), events: ProviderEvent[] = [], approved: string[] = [];
  const result = await runClaude({ provider: "claude", cwd: f.cwd, scratchDir: f.scratch, prompt: "repair source", signal: new AbortController().signal,
    onEvent: event => { events.push(event); }, approve: async request => { approved.push(request.id); return true; } }, f.policy, f.dependency);
  assert.equal(result.status, "completed"); assert.equal(result.sessionId, "claude-saved");
  assert.deepEqual(approved, []); assert.deepEqual(f.checks(), { checked: true, disposed: true });
  const decisions = readFileSync(f.responses, "utf8").trim().split("\n").map(line => JSON.parse(line).response);
  assert.deepEqual(decisions.filter(item => item.response.behavior).map(item => [item.request_id, item.response.behavior]), [["probe", "allow"], ["outside", "deny"], ["bypass", "deny"], ["safe", "allow"]]);
  assert.deepEqual(f.commands, ["trusted probe", "node --test"]);
  assert.equal(events[0].type, "session"); assert.ok(events.some(event => event.type === "message"));
});

test("Claude cancellation before a coding command prevents its dispatch", async t => {
  const f = fakeClaude(t), controller = new AbortController();
  const result = await runClaude({ provider: "claude", cwd: f.cwd, scratchDir: f.scratch, prompt: "repair source", signal: controller.signal,
    onEvent: event => { if (event.type === "permission" && event.data.phase === "coding") controller.abort(); }, approve: async () => { throw new Error("No routine permission prompt is needed."); } }, f.policy, f.dependency);
  assert.equal(result.status, "cancelled"); assert.equal(f.checks().disposed, true);
  assert.deepEqual(f.commands, ["trusted probe"]);
});

test("Claude persists its resumed native session before submitting the source task", async t => {
  const f = fakeClaude(t);
  const result = await runClaude({ provider: "claude", cwd: f.cwd, scratchDir: f.scratch, prompt: "continue", sessionId: "previous-session", signal: new AbortController().signal,
    onEvent: async event => { if (event.type === "session") { await new Promise(resolve => setTimeout(resolve, 30)); assert.doesNotMatch(readFileSync(f.calls, "utf8"), /candidate workspace/); } }, approve: async () => true }, f.policy, f.dependency);
  assert.equal(result.status, "completed");
  assert.ok(JSON.parse(readFileSync(f.launch, "utf8")).includes("--resume=previous-session"));
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const turns = calls.filter(value => value.type === "user");
  assert.equal(turns[0].session_id, "previous-session"); assert.equal(turns[1].session_id, "previous-session");
});

test("Claude stops before any shell command if native initialization exposes another tool", async t => {
  const f = fakeClaude(t), executable = path.join(f.policy.environment.PATH!, "claude");
  writeFileSync(executable, readFileSync(executable, "utf8").replace("tools:[tool]", "tools:[tool,'Bash']"));
  const result = await runClaude({ provider: "claude", cwd: f.cwd, scratchDir: f.scratch, prompt: "repair", signal: new AbortController().signal,
    onEvent: () => {}, approve: async () => true }, f.policy, f.dependency);
  assert.equal(result.status, "failed"); assert.match(result.error!, /outside the single/); assert.deepEqual(f.commands, []);
});

test("Claude cancellation waits for its in-flight restricted command to stop", async t => {
  const f = fakeClaude(t), controller = new AbortController(); let commandClosed = false, rejectCommand: ((error: Error) => void) | undefined;
  f.dependency.shell.execute = async command => {
    if (command === "trusted probe") return { exitCode: 0, stdout: "passed", stderr: "" };
    setTimeout(() => controller.abort(), 10);
    return new Promise((_resolve, reject) => { rejectCommand = reject; });
  };
  f.dependency.shell.close = async () => { if (rejectCommand) { await new Promise(resolve => setTimeout(resolve, 20)); commandClosed = true; rejectCommand(new Error("command cancelled")); } };
  const result = await runClaude({ provider: "claude", cwd: f.cwd, scratchDir: f.scratch, prompt: "run tests", signal: controller.signal,
    onEvent: () => {}, approve: async () => true }, f.policy, f.dependency);
  assert.equal(result.status, "cancelled"); assert.equal(commandClosed, true);
});

test("Studio SDK MCP rejects other servers, methods and caller supplied execution policy", async () => {
  const ran: string[] = [], run = async (command: string) => { ran.push(command); return { exitCode: 3, stdout: "test failed", stderr: "" }; };
  await assert.rejects(studioShellMessage("unmanaged", { jsonrpc: "2.0", id: 1, method: "tools/list" }, run), /Unsupported/);
  for (const message of [
    { method: "resources/read", params: { uri: "file:///private" } },
    { method: "tools/call", params: { name: "run", arguments: { command: "node --test", cwd: "/" } } },
    { method: "tools/call", params: { name: "other", arguments: { command: "node --test" } } },
  ]) {
    const result = await studioShellMessage("studio_shell", { jsonrpc: "2.0", id: 2, ...message }, run);
    assert.ok("error" in result);
  }
  assert.deepEqual(ran, []);
  const result = await studioShellMessage("studio_shell", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run", arguments: { command: "node --test" } } }, run);
  assert.deepEqual(ran, ["node --test"]); assert.ok("result" in result && "isError" in result.result && result.result.isError);
});

test("transport setup diagnostics classify native failure without leaking configuration text", async t => {
  const { cwd } = fixture(t);
  const child = new JsonLinesProcess(process.execPath, ["-e", "process.stderr.write('missing field `command`: SECRET_SENTINEL config-value');process.exit(1)"], cwd, process.env, async () => {}, async () => {});
  await child.closed;
  assert.equal(child.setupFailure(), "invalid configuration schema");
  assert.doesNotMatch(child.setupFailure(), /SECRET_SENTINEL|config-value/);
});

test("provider output chunks preserve Unicode and escaped control bytes below the durable event limit", async () => {
  const events: ProviderEvent[] = [], stdout = "\0".repeat(32768), stderr = "\u0001".repeat(32768), message = "😀".repeat(5000);
  const emit = (event: ProviderEvent) => { events.push(event); };
  await emitText(emit, "command", { phase: "output" }, "stdout", stdout);
  await emitText(emit, "command", { phase: "output" }, "stderr", stderr);
  await emitText(emit, "message", {}, "text", message);
  events.push({ type: "command", data: commandSummary("\0".repeat(32000)) });
  assert.ok(events.every(event => Buffer.byteLength(JSON.stringify(event.data)) < 64 * 1024));
  assert.equal(events.map(event => event.data.stdout ?? "").join(""), stdout);
  assert.equal(events.map(event => event.data.stderr ?? "").join(""), stderr);
  assert.equal(events.filter(event => event.type === "message").map(event => event.data.text).join(""), message);
});

test("JSONL transport preserves UTF-8 and awaits event persistence in order", async t => {
  const { cwd } = fixture(t);
  const script = `const b=Buffer.from(JSON.stringify({text:'λ😀'})+'\\n'+JSON.stringify({text:'second'})+'\\n');process.stdout.write(b.subarray(0,11));setTimeout(()=>{process.stdout.write(b.subarray(11));},10);process.stdin.resume();`;
  const events: string[] = [];
  const process = new JsonLinesProcess(global.process.execPath, ["-e", script], cwd, global.process.env, async value => {
    events.push(`start:${value.text}`); await new Promise(resolve => setTimeout(resolve, 20)); events.push(`end:${value.text}`);
    if (value.text === "second") process.stop();
  }, async () => {});
  await process.closed;
  assert.deepEqual(events, ["start:λ😀", "end:λ😀", "start:second", "end:second"]);
  assert.equal(process.error(), undefined);
});

test("durable-consumer failure stops provider and suppresses later events", async t => {
  const { cwd } = fixture(t); let calls = 0;
  const child = new JsonLinesProcess(process.execPath, ["-e", "console.log('{}');console.log('{}');process.stdin.resume()"], cwd, process.env,
    async () => { calls++; throw new Error("disk full"); }, async () => {});
  await child.closed;
  assert.equal(calls, 1); assert.match(child.error()!.message, /disk full/);
});

test("failed consumers drain buffered stdout so cancellation can observe process close", { timeout: 5000 }, async t => {
  const { cwd } = fixture(t); let calls = 0;
  const child = new JsonLinesProcess(process.execPath, ["-e", "process.stdout.write('{}\\n'.repeat(100000));process.stdin.resume()"], cwd, process.env,
    async () => { calls++; throw new Error("consumer cancelled"); }, async () => {});
  await child.closed;
  assert.equal(calls, 1); assert.match(child.error()!.message, /consumer cancelled/);
});

test("malformed provider frames fail closed", async t => {
  const { cwd } = fixture(t);
  const child = new JsonLinesProcess(process.execPath, ["-e", "console.log('not json');process.stdin.resume()"], cwd, process.env, async () => assert.fail(), async () => {});
  await child.closed; assert.ok(child.error());
});

test("tether kills an owned descendant before transport closes", { skip: process.platform === "win32" }, async t => {
  const { cwd } = fixture(t), record = path.join(cwd, "descendant.pid");
  const script = `const cp=require('node:child_process'),fs=require('node:fs');const p=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(record)},String(p.pid));console.log('{}');process.stdin.resume();`;
  const child: JsonLinesProcess = new JsonLinesProcess(process.execPath, ["-e", script], cwd, process.env, async () => { child.stop(); }, async () => {});
  await child.closed;
  const pid = Number(readFileSync(record, "utf8"));
  // SIGKILL can leave a short-lived zombie until the OS reaps it; it cannot run.
  let alive = true;
  for (let n = 0; n < 40; n++) { try { process.kill(pid, 0); } catch { alive = false; break; } await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.equal(alive, false);
});

test("Codex adapter refuses a failed native boundary probe before starting any thread", { skip: process.platform === "win32" }, async t => {
  const { root, cwd, scratch } = fixture(t); const bin = path.join(root, "bin"); mkdirSync(bin);
  const calls = path.join(root, "calls.jsonl");
  const fake = path.join(bin, "codex");
  writeFileSync(fake, `#!${process.execPath}\nconst readline=require('node:readline'),fs=require('node:fs');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},line+'\\n');if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='config/read'?{config:{mcp_servers:{}}}:m.method==='command/exec'?{exitCode:12,stdout:'{"violations":["read"]}'}:{}}));});\n`); chmodSync(fake, 0o700);
  const policy = executionPolicy(cwd, scratch); policy.environment.PATH = bin;
  const events: ProviderEvent[] = [];
  const result = await runCodex({ provider: "codex", cwd, scratchDir: scratch, prompt: "must never run", signal: new AbortController().signal, onEvent: event => { events.push(event); } }, policy,
    { probe: async () => { throw new Error("Codex sandbox boundary probe failed"); } });
  assert.equal(result.status, "failed"); assert.match(result.error!, /boundary probe/);
  assert.ok(existsSync(calls)); assert.doesNotMatch(readFileSync(calls, "utf8"), /thread\/start|turn\/start/);
  assert.equal(events.length, 0);
});

function fakeCodex(t: TestContext, holdTurn = false, mcpMode: "none" | "disable" | "fixed" = "none") {
  const f = fixture(t), bin = path.join(f.root, "bin"); mkdirSync(bin);
  const fake = path.join(bin, "codex"), calls = path.join(f.root, "calls.jsonl");
  const script = [
    "#!" + process.execPath,
    "const rl=require('node:readline'),fs=require('node:fs');const out=m=>console.log(JSON.stringify(m));",
    "rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(" + JSON.stringify(calls) + ",line+'\\n');",
    "if(m.method==='initialize')out({id:m.id,result:{}});",
    "else if(m.method==='config/read')out({id:m.id,result:{config:{mcp_servers:" + (mcpMode === "none" ? "{}" : "{unmanaged:{command:'never-run',enabled:" + (mcpMode === "fixed" ? "true" : "!process.argv.includes('mcp_servers={\"unmanaged\"={\"enabled\"=false}}')") + "}}") + "}}});",
    "else if(m.method==='test/config')out({id:m.id,result:{home:process.env.CODEX_HOME,config:fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'),auth:fs.existsSync(process.env.CODEX_HOME+'/auth.json')}});",
    "else if(m.method==='thread/start'||m.method==='thread/resume')out({id:m.id,result:{thread:{id:m.params.threadId||'saved-thread'},cwd:m.params.cwd}});",
    "else if(m.method==='turn/start'){out({id:m.id,result:{turn:{id:'turn-1'}}});out({method:'item/agentMessage/delta',params:{delta:'Working',itemId:'msg-1'}});out({method:'item/started',params:{item:{type:'commandExecution',id:'cmd',command:'node --test',cwd:m.params.cwd}}});",
    holdTurn ? "}" : "out({method:'item/completed',params:{item:{type:'commandExecution',id:'cmd',exitCode:0,status:'completed'}}});out({method:'item/completed',params:{item:{type:'fileChange',id:'file',changes:[{path:'source.ts',kind:{type:'update'},diff:'x'.repeat(200000)}]}}});out({method:'turn/completed',params:{turn:{status:'completed'}}});}",
    "else if(m.method==='turn/interrupt'){out({id:m.id,result:{}});out({method:'turn/completed',params:{turn:{status:'interrupted'}}});}",
    "});",
  ].join("\n");
  writeFileSync(fake, script); chmodSync(fake, 0o700);
  const policy = executionPolicy(f.cwd, f.scratch); policy.environment.PATH = bin;
  return { ...f, policy, calls };
}

test("Codex resumes with its fixed profile and persists the session before starting the native turn", async t => {
  const f = fakeCodex(t), events: ProviderEvent[] = [];
  const result = await runCodex({ provider: "codex", cwd: f.cwd, scratchDir: f.scratch, prompt: "repair", sessionId: "previous-thread", signal: new AbortController().signal,
    onEvent: async event => {
      events.push(event);
      if (event.type === "session") { await new Promise(resolve => setTimeout(resolve, 20)); assert.doesNotMatch(readFileSync(f.calls, "utf8"), /turn\/start/); }
    } }, f.policy, { probe: async () => {} });
  assert.equal(result.status, "completed"); assert.equal(result.sessionId, "previous-thread");
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const resumed = calls.find(value => value.method === "thread/resume");
  assert.equal(resumed.params.threadId, "previous-thread"); assert.equal(resumed.params.permissions, f.policy.profile);
  assert.equal(resumed.params.approvalPolicy, "never"); assert.ok(events.some(event => event.type === "file"));
  assert.ok(events.every(event => Buffer.byteLength(JSON.stringify(event.data)) < 64 * 1024));
  assert.deepEqual(events.find(event => event.type === "file")!.data.changes, [{ path: "source.ts", kind: "update" }]);
});

test("Codex cancellation interrupts its owned turn and waits for teardown", async t => {
  const f = fakeCodex(t, true), controller = new AbortController();
  const result = await runCodex({ provider: "codex", cwd: f.cwd, scratchDir: f.scratch, prompt: "repair", signal: controller.signal,
    onEvent: event => { if (event.type === "command") setTimeout(() => controller.abort(), 5); } }, f.policy, { probe: async () => {} });
  assert.equal(result.status, "cancelled"); assert.match(readFileSync(f.calls, "utf8"), /turn\/interrupt/);
});

test("model-free Codex configuration avoids argv limits and never copies login material", async t => {
  const f = fakeCodex(t), connection = new CodexConnection(f.policy, async () => {}, { isolatedConfig: true });
  let home: string | undefined;
  try {
    await connection.initialize();
    const data = await connection.request("test/config", {});
    home = data.home;
    assert.ok(home?.startsWith(path.dirname(f.policy.scratchDir) + path.sep));
    assert.equal(data.auth, false); assert.match(data.config, new RegExp(f.policy.profile));
    assert.equal(connection.transport.child.spawnargs.includes("-c"), false);
  } finally { connection.transport.stop(); await connection.transport.closed; }
  assert.equal(existsSync(home!), false);
});

test("Codex disables inherited MCP entries with process-local overrides before creating a model thread", async t => {
  const f = fakeCodex(t, false, "disable");
  const result = await runCodex({ provider: "codex", cwd: f.cwd, scratchDir: f.scratch, prompt: "repair", signal: new AbortController().signal, onEvent: () => {} }, f.policy, { probe: async () => {} });
  assert.equal(result.status, "completed");
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.filter(value => value.method === "initialize").length, 2);
  assert.deepEqual(calls.find(value => value.method === "thread/start").params.config.mcp_servers, { unmanaged: { enabled: false } });
});

test("Codex refuses to create a model thread when effective MCP suppression cannot be verified", async t => {
  const f = fakeCodex(t, false, "fixed");
  const result = await runCodex({ provider: "codex", cwd: f.cwd, scratchDir: f.scratch, prompt: "repair", signal: new AbortController().signal, onEvent: () => {} }, f.policy, { probe: async () => {} });
  assert.equal(result.status, "failed"); assert.match(result.error!, /MCP/);
  assert.doesNotMatch(readFileSync(f.calls, "utf8"), /thread\/start|turn\/start/);
});
