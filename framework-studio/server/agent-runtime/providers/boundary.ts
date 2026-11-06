import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionPolicy } from "../policy";

export interface BoundaryFixture {
  readonly command: string[];
  readonly shellCommand: string;
  readonly sentinelPath: string;
  assert(exitCode: number, stdout: string, stderr?: string): void;
  dispose(): Promise<void>;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Every forbidden target is disposable and owned by this probe. No real secret,
 * Docker socket, Studio listener, or unrelated process is ever accessed/signalled.
 */
export async function createBoundaryFixture(policy: ExecutionPolicy): Promise<BoundaryFixture> {
  const directory = mkdtempSync(path.join(tmpdir(), "studio-boundary-"));
  const sentinelPath = path.join(directory, "private.txt"), marker = randomUUID(), nonce = randomUUID();
  const link = path.join(policy.scratchDir, `boundary-link-${nonce}`);
  const scriptPath = path.join(policy.scratchDir, `boundary-${nonce}.cjs`);
  const proofPath = path.join(policy.scratchDir, `boundary-${nonce}.json`);
  const readonlyTarget = path.join(policy.cwd, `studio-readonly-boundary-${nonce}.txt`);
  const runtimeTarget = path.join(policy.runtimeDirectory, `studio-runtime-boundary-${nonce}.txt`);
  const listener = createServer(socket => socket.destroy()), unixListener = createServer(socket => socket.destroy());
  let child: ChildProcess | undefined;
  const dispose = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
      child.kill(); await exited;
    }
    await Promise.all([listener, unixListener].map(server => new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()); })));
    for (const file of [link, scriptPath, proofPath, runtimeTarget, ...(policy.readOnlyCwd ? [readonlyTarget] : [])]) rmSync(file, { force: true });
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    writeFileSync(sentinelPath, marker, { mode: 0o600 }); symlinkSync(sentinelPath, link);
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Cannot prepare network sentinel.");
    const socketPath = path.join(directory, "d.sock");
    await new Promise<void>((resolve, reject) => { unixListener.once("error", reject); unixListener.listen(socketPath, resolve); });
    child = spawn(process.execPath, ["-e", "process.on('SIGUSR1',()=>process.exit(77));process.stdin.on('end',()=>process.exit(0));process.stdin.resume();process.stdout.write('ready');setTimeout(()=>process.exit(0),300000)"], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The disposable process sentinel did not start.")), 5000);
      child!.once("error", error => { clearTimeout(timer); reject(error); });
      child!.once("exit", () => { clearTimeout(timer); reject(new Error("The disposable process sentinel exited before readiness.")); });
      child!.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
    });
    const script = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');const violations=[];
for(const p of ${JSON.stringify([sentinelPath, link])}){try{fs.readFileSync(p);violations.push('outside-read')}catch{}try{fs.writeFileSync(p,'changed');violations.push('outside-write')}catch{}}
try{process.kill(${child.pid},'SIGUSR1');violations.push('outside-process-signal')}catch{}
for(const name of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY','DATABASE_URL','GITHUB_TOKEN','GH_TOKEN','NPM_TOKEN','SSH_AUTH_SOCK','NODE_OPTIONS'])if(process.env[name])violations.push('credential-env:'+name);
try{fs.writeFileSync(${JSON.stringify(runtimeTarget)},'trusted runtime write probe',{flag:'wx'});violations.push('trusted-runtime-write')}catch{}
${policy.readOnlyCwd ? `try{fs.writeFileSync(${JSON.stringify(readonlyTarget)},'read-only probe',{flag:'wx'});violations.push('readonly-source-write')}catch{}` : ""}
const child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`try{require('node:fs').readFileSync(${JSON.stringify(sentinelPath)});process.exit(9)}catch{process.exit(0)}`)}]);if(child.status!==0)violations.push('descendant-read');
async function connect(options,label){await new Promise(resolve=>{const socket=net.createConnection(options);socket.on('connect',()=>{violations.push(label);socket.destroy()});socket.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))violations.push(label+'-not-enforced:'+e.code)});socket.setTimeout(1000,()=>{violations.push(label+'-timeout');socket.destroy()});socket.on('close',resolve)});}
Promise.all([connect({host:'127.0.0.1',port:${address.port}},'localhost'),connect({host:'192.0.2.1',port:9},'external-network'),connect({path:${JSON.stringify(socketPath)}},'unix-socket')]).then(()=>{const proof={nonce:${JSON.stringify(nonce)},violations};fs.writeFileSync(${JSON.stringify(proofPath)},JSON.stringify(proof));console.log(JSON.stringify(proof));process.exitCode=violations.length?12:0});`;
    writeFileSync(scriptPath, script, { flag: "wx", mode: 0o400 });
    const command = [path.join(policy.runtimeDirectory, "node"), scriptPath];
    return {
      command, shellCommand: [path.join(policy.runtimeDirectory, "node"), scriptPath].map(quote).join(" "), sentinelPath,
      assert(exitCode, stdout, stderr = "") {
        let proof: { nonce?: string; violations?: unknown } | undefined;
        try { proof = JSON.parse(readFileSync(proofPath, "utf8")); } catch { /* Missing proof fails closed. */ }
        if (child?.exitCode !== null || child?.signalCode !== null || readFileSync(sentinelPath, "utf8") !== marker || exitCode !== 0 || proof?.nonce !== nonce || !Array.isArray(proof.violations) || proof.violations.length)
          throw new Error(`Native sandbox boundary probe failed; coding remains disabled. Trusted sentinel command exit=${exitCode} stdout=${stdout.slice(0, 1000)} stderr=${stderr.slice(0, 1500)}`);
      }, dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
