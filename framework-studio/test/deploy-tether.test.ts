import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TETHER } from "../server/deploy/process";

/**
 * The watch and the web client must not outlive Studio, however it ends: a
 * tethered program is stopped when the pipe from Studio closes, which the
 * operating system does even when Studio is killed outright.
 *
 * The program here is shaped like `npm run dev`: a process that keeps writing
 * output and has started a long-lived child of its own (Vite).
 */

const scratchRoot = path.resolve(__dirname, "..", "..", ".cache");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a tethered program and what it started stop when Studio is killed outright", async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-tether-"));
  const pids: number[] = [];
  let parent: ReturnType<typeof spawn> | undefined;
  try {
    const marker = path.join(directory, "grandchild.pid");
    // Vite: started by the program, writes nothing, never exits on its own.
    const grandchild = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
    // npm: starts Vite, then keeps writing to its output, which reaches Studio.
    const program = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setInterval(() => process.stdout.write("tick\\n"), 50);`;
    // Studio: reads the tether's output through a pipe, as the job manager does.
    const studio = `const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(TETHER)}, process.execPath, "-e", ${JSON.stringify(program)}], { stdio: ["pipe", "pipe", "pipe"] }); child.stdout.resume(); child.stderr.resume(); setInterval(() => {}, 1000);`;
    parent = spawn(process.execPath, ["-e", studio], { stdio: "ignore" });
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = Number(readFileSync(marker, "utf8"));
    pids.push(pid);
    assert.ok(alive(pid), "the program's own child runs");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Killed outright: no handler of Studio's runs.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(parent.pid), "/F"], { stdio: "ignore" });
    else parent.kill("SIGKILL");
    let gone = false;
    for (let attempt = 0; attempt < 80 && !gone; attempt++) {
      gone = !alive(pid);
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(gone, "what the program started stopped with Studio");
  } finally {
    if (parent?.pid && alive(parent.pid)) parent.kill("SIGKILL");
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});
