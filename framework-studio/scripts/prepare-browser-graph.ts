import fs from "node:fs/promises";
import path from "node:path";
import type { Snapshot } from "../shared/model";
import { graphFixture } from "./support/graph-fixture";

// Prepare a Playwright CLI run-code function. Serve the existing Studio production
// build with vite preview; every API request below stays intercepted in this tab.
// Usage: node --import tsx framework-studio/scripts/prepare-browser-graph.ts snapshot.json output.js [url]
const [snapshotFile, outputFile, origin = "http://127.0.0.1:4592"] = process.argv.slice(2);
if (!snapshotFile || !outputFile) throw new Error("Supply a sanitized Snapshot JSON file and an output JavaScript path.");
void (async () => {
const input = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
const snapshot: Snapshot = input.snapshot ?? input;
const fixtures = [25, 100, 250, 500].map(size => ({ size, snapshot: { ...snapshot, revision: `synthetic-${size}`, models: { dev: graphFixture(size, "dev"), prod: graphFixture(size, "prod") } } }));
const code = `async (page) => {
  const fixtures = ${JSON.stringify(fixtures)};
  let active = fixtures[0];
  const errors = [];
  const cdp = await page.context().newCDPSession(page);
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.__job4LongTasks = [];
    window.__job4Events = { created: 0, closed: 0, active: 0, peak: 0 };
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      #closed = false;
      constructor(...args) { super(...args); const counts = window.__job4Events; counts.created++; counts.active++; counts.peak = Math.max(counts.peak, counts.active); }
      close() { if (!this.#closed) { this.#closed = true; window.__job4Events.closed++; window.__job4Events.active--; } super.close(); }
    };
    new PerformanceObserver(list => window.__job4LongTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: 'longtask', buffered: true });
  });
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/snapshot') return route.fulfill({ json: { snapshot: active.snapshot, history: {}, evaluating: false, commands: {}, busy: null } });
    if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 3600000\\n\\n' });
    if (pathname === '/api/source-recovery') return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: 'Unavailable in the presentation benchmark' } });
  });
  const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { samples: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) }; };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const results = [];
  for (const fixture of fixtures) {
    active = fixture;
    const loads = [];
    for (let at = 0; at < 5; at++) {
      const start = Date.now();
      await page.goto(${JSON.stringify(origin + "/")}, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(size => window.__studioLandscape?.stats().nodes === size, fixture.size);
      loads.push(Date.now() - start);
    }
    await page.evaluate(() => document.fonts.ready);
    await settle();
    const search = page.getByRole('searchbox', { name: 'Search isometric map' });
    const searches = [], inspectors = [];
    for (let at = 0; at < 5; at++) {
      let start = Date.now();
      await search.fill(at % 2 ? 'fixture 7' : 'fixture');
      await settle(); searches.push(Date.now() - start);
    }
    await search.fill('');
    for (let at = 0; at < 5; at++) {
      const start = Date.now();
      await page.getByRole('list', { name: 'Entities in the landscape' }).getByRole('button').filter({ hasText: /^fixture-0, HTTP Lambda/ }).press('Enter');
      await page.getByRole('heading', { name: 'Fixture handler 0', exact: true }).waitFor();
      await settle(); inspectors.push(Date.now() - start);
      await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    }
    await page.getByRole('list', { name: 'Entities in the landscape' }).getByRole('button').filter({ hasText: /^fixture-0, HTTP Lambda/ }).press('Enter');
    await page.getByRole('button', { name: 'Resume motion', exact: true }).click();
    const paint = await page.evaluate(() => new Promise(resolve => {
      const draws = [], intervals = []; let frames = -1, previous = 0, remaining = 90;
      const tick = now => { const state = window.__studioLandscape.stats(); if (state.frames !== frames) { draws.push(state.lastFrameMs); frames = state.frames; } if (previous) intervals.push(now - previous); previous = now; if (--remaining) requestAnimationFrame(tick); else resolve({ draws, intervals }); };
      requestAnimationFrame(tick);
    }));
    await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    const state = await page.evaluate(() => ({ stats: window.__studioLandscape.stats(), longTasks: window.__job4LongTasks, domNodes: document.querySelectorAll('*').length, eventStreams: window.__job4Events }));
    state.heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    results.push({ size: fixture.size, loads: summary(loads), searches: summary(searches), inspectors: summary(inspectors), drawing: summary(paint.draws), frameIntervals: summary(paint.intervals), ...state });
  }
  // Warm the lazy Database module before comparing retained memory across navigation.
  await page.getByRole('link', { name: 'Database', exact: true }).click();
  await page.getByRole('navigation', { name: 'Database workspace', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Map', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search isometric map' }).waitFor();
  await settle(); await cdp.send('HeapProfiler.collectGarbage');
  const retainedBefore = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  const cycles = 30;
  for (let at = 0; at < cycles; at++) {
    await page.getByRole('link', { name: 'Database', exact: true }).click();
    await page.getByRole('navigation', { name: 'Database workspace', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Map', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search isometric map' }).waitFor();
    await page.getByRole('searchbox', { name: 'Search isometric map' }).fill('fixture 7');
    await page.getByRole('searchbox', { name: 'Search isometric map' }).fill('');
  }
  await settle(); await cdp.send('HeapProfiler.collectGarbage');
  const retainedAfter = await page.evaluate(() => ({ domNodes: document.querySelectorAll('*').length, eventStreams: window.__job4Events }));
  retainedAfter.heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  await cdp.detach();
  return { browser: await page.context().browser().version(), viewport: page.viewportSize(), results, sustained: { cycles, retainedBefore, ...retainedAfter }, errors };
}`;
await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.writeFile(outputFile, code);
})();
