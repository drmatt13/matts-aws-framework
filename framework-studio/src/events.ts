interface EventStream {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
}

/** Snapshot and deployment observers consume the same server stream. Sharing
 * one connection per tab leaves HTTP/1 connection slots for reads and approvals
 * when developers open several Studio tabs. Each subscriber owns its listeners.
 */
export function createStudioEventHub(factory: (url: string) => EventStream) {
  const streams = new Map<string, { source: EventStream; subscribers: number }>();
  return (token: string) => {
    let entry = streams.get(token);
    if (!entry) {
      entry = { source: factory(`/api/events?token=${encodeURIComponent(token)}`), subscribers: 0 };
      streams.set(token, entry);
    }
    const connected = entry;
    connected.subscribers++;
    const listeners: { type: string; listener: EventListener }[] = [];
    let closed = false;
    return {
      addEventListener(type: string, listener: EventListener) {
        if (closed) return;
        connected.source.addEventListener(type, listener);
        listeners.push({ type, listener });
      },
      close() {
        if (closed) return;
        closed = true;
        for (const { type, listener } of listeners) connected.source.removeEventListener(type, listener);
        if (--connected.subscribers === 0) {
          connected.source.close();
          streams.delete(token);
        }
      },
    };
  };
}

export const connectStudioEvents = createStudioEventHub(url => new EventSource(url));
