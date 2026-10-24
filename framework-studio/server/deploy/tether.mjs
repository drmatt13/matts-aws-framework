#!/usr/bin/env node
/**
 * Runs a program for as long as the process that started this one is alive.
 *
 *   node tether.mjs <file> [args...]
 *
 * Studio starts the source watch and the web client through this, with a pipe
 * for stdin that it never writes. When Studio ends — cleanly, or killed outright
 * — the operating system closes that pipe, and this stops the program and
 * everything it started. Output passes straight through.
 */
import { spawn, spawnSync } from "node:child_process";

const [file, ...args] = process.argv.slice(2);
if (!file) {
  process.stderr.write("tether.mjs needs a program to run.\n");
  process.exit(2);
}

const child = spawn(file, args, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true, detached: process.platform !== "win32" });
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  if (child.exitCode !== null || child.pid === undefined) process.exit(0);
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ } process.exit(0); }, 5000).unref();
  }
}

child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  // The program may exit before descendants that ignored its termination
  // signal. Its detached group belongs to this tether, so finish that group
  // before exiting and canceling the escalation timer. Never signal our group.
  if (process.platform !== "win32" && child.pid !== undefined) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Owned group already gone. */ }
  }
  process.exit(code ?? (signal ? 1 : 0));
});
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.on("error", stop);
process.stdin.resume();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
