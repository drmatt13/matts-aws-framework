/** Installed before application modules. Native SSE transport is covered by events.test.ts. */
export function installEvents() {
  const streams = new Set<EventTarget & { close(): void }>();
  class FixtureEventSource extends EventTarget {
    readonly url: string;
    readonly withCredentials = false;
    readyState = 1;
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    CONNECTING = 0; OPEN = 1; CLOSED = 2;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(url: string | URL) {
      super(); this.url = String(url);
      const destination = new URL(this.url, location.href);
      if (destination.origin !== location.origin || destination.pathname !== "/api/events" || destination.searchParams.get("token") !== "browser-fixture-token") throw new Error(`Unexpected fixture EventSource: ${destination}`);
      streams.add(this);
      setTimeout(() => { if (this.readyState !== 2) { this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify({ sourceWatch: { status: "watching", checkedAt: "2026-10-28T12:00:00.000Z", pollIntervalMs: 1000, problems: [] } }) })); } }, 0);
    }
    close() { this.readyState = 2; streams.delete(this); }
  }
  Object.defineProperty(window, "EventSource", { configurable: true, value: FixtureEventSource });
  Object.assign(window, { __studioBrowserEvents: {
    emit(type: string, data: unknown) { for (const stream of streams) stream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); },
    active() { return streams.size; },
  } });
}
