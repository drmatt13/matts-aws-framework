const { renameSync } = require("node:fs");

/** Windows readers can temporarily prevent replacement of a closed file.
 * Retry the same atomic rename for at most five seconds, preserving the old
 * destination throughout. Never unlink or change permissions to force a write.
 * Options provide deterministic I/O and time boundaries for regression tests.
 */
function replaceFileAtomic(from, to, options = {}) {
  const { replace = renameSync, platform = process.platform, now = Date.now,
    wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds), timeoutMs = 5_000 } = options;
  const deadline = now() + timeoutMs;
  let delay = 10;
  for (;;) {
    try { replace(from, to); return; }
    catch (error) {
      const remaining = deadline - now();
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || remaining <= 0) throw error;
      wait(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 100);
    }
  }
}

exports.replaceFileAtomic = replaceFileAtomic;
