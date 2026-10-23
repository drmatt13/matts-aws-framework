import type { DiffLine } from "./api";

type Step = { kind: DiffLine["kind"]; text: string };

/** Myers' shortest edit path. Bound the trace for very large regenerated files. */
function sequence(a: readonly string[], b: readonly string[]): Step[] {
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
  const leading: Step[] = a.slice(0, prefix).map(text => ({ kind: "context", text }));
  const trailing: Step[] = suffix ? a.slice(-suffix).map(text => ({ kind: "context", text })) : [];
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]), work = 0;
  for (let distance = 0; distance <= left.length + right.length; distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > 500_000) {
        // No quadratic memory/CPU surprise in a review of an entirely new lockfile.
        // Keep common unique anchors, then solve each smaller gap independently.
        const positions = (items: readonly string[]) => {
          const result = new Map<string, number>();
          items.forEach((line, at) => result.set(line, result.has(line) ? -1 : at));
          return result;
        };
        const x = positions(left), y = positions(right);
        const anchors = [...x].filter(([line, at]) => at >= 0 && (y.get(line) ?? -1) >= 0).map(([line, at]) => [at, y.get(line)!] as const);
        // A monotonic subset is sufficient for a truthful, bounded fallback.
        const middle: Step[] = []; let previousX = 0, previousY = 0;
        for (const [atX, atY] of anchors) {
          if (atY < previousY) continue;
          middle.push(...sequence(left.slice(previousX, atX), right.slice(previousY, atY)), { kind: "context", text: left[atX]! });
          previousX = atX + 1; previousY = atY + 1;
        }
        if (!middle.length) return [...leading, ...left.map(text => ({ kind: "remove" as const, text })), ...right.map(text => ({ kind: "add" as const, text })), ...trailing];
        middle.push(...sequence(left.slice(previousX), right.slice(previousY)));
        return [...leading, ...middle, ...trailing];
      }
      let x = diagonal === -distance || diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1)
        ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < left.length && y < right.length && left[x] === right[y]) { x++; y++; }
      frontier.set(diagonal, x);
      if (x < left.length || y < right.length) continue;
      const backwards: Step[] = [];
      for (let d = distance; d >= 0; d--) {
        const v = trace[d]!, k = x - y;
        const previousK = k === -d || k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1) ? k + 1 : k - 1;
        const previousX = v.get(previousK) ?? 0, previousY = previousX - previousK;
        while (x > previousX && y > previousY) { backwards.push({ kind: "context", text: left[--x]! }); y--; }
        if (d > 0) {
          if (x === previousX) backwards.push({ kind: "add", text: right[--y]! });
          else backwards.push({ kind: "remove", text: left[--x]! });
        }
      }
      return [...leading, ...backwards.reverse(), ...trailing];
    }
  }
  return leading;
}

/** Exact multi-hunk review; omitted context never masquerades as rewritten source. */
export function sourceDiff(file: string, before: string, after: string, context = 3): { unified: string; lines: readonly DiffLine[] } {
  if (before === after) return { unified: "", lines: [] };
  const split = (text: string) => text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const steps = sequence(split(before), split(after));
  // A terminal-newline-only change needs a real remove/add, with standard markers.
  if (before.endsWith("\n") !== after.endsWith("\n") && steps.at(-1)?.kind === "context") {
    const last = steps.pop()!;
    steps.push({ kind: "remove", text: last.text }, { kind: "add", text: last.text });
  }
  let oldLine = 0, newLine = 0;
  const numbered = steps.map(step => ({ ...step, ...(step.kind !== "add" ? { oldLine: ++oldLine } : {}), ...(step.kind !== "remove" ? { newLine: ++newLine } : {}) }));
  const ranges: { start: number; end: number }[] = [];
  const padding = Math.max(0, Math.floor(context));
  numbered.forEach((line, at) => {
    if (line.kind === "context") return;
    const start = Math.max(0, at - padding), end = Math.min(numbered.length, at + padding + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  });
  const lines: DiffLine[] = [], hunks: string[] = [];
  for (const { start, end } of ranges) {
    const hunk = numbered.slice(start, end);
    const oldCount = hunk.filter(line => line.kind !== "add").length, newCount = hunk.filter(line => line.kind !== "remove").length;
    const oldBefore = numbered.slice(0, start).filter(line => line.kind !== "add").length;
    const newBefore = numbered.slice(0, start).filter(line => line.kind !== "remove").length;
    const header = `@@ -${oldBefore + (oldCount ? 1 : 0)},${oldCount} +${newBefore + (newCount ? 1 : 0)},${newCount} @@`;
    const body: string[] = [];
    hunk.forEach((line, at) => {
      lines.push({ ...line, ...(at === 0 ? { hunk: header } : {}) });
      body.push(`${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${line.text}`);
      if (line.oldLine === oldLine && line.kind !== "add" && before && !before.endsWith("\n") || line.newLine === newLine && line.kind !== "remove" && after && !after.endsWith("\n")) body.push("\\ No newline at end of file");
    });
    hunks.push(header, ...body);
  }
  return { unified: `--- a/${file}\n+++ b/${file}\n${hunks.join("\n")}\n`, lines };
}
