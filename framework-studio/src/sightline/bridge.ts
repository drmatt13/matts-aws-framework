import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { WorkspaceFragments } from "./workspace";

/** One-way readers of committed workspace state. No reader runs without a consumer. */
export function createSightlineWorkspaceRegistry() {
  const readers = new Map<
    keyof WorkspaceFragments,
    { owner: symbol; read: () => unknown }
  >();
  const listeners = new Set<() => void>();
  let value: WorkspaceFragments = {};
  let serialized = "{}";
  const refresh = () => {
    if (!listeners.size) return;
    const next = Object.fromEntries(
      [...readers].map(([key, entry]) => [key, entry.read()]),
    ) as WorkspaceFragments;
    const bytes = JSON.stringify(next);
    if (bytes === serialized) return;
    value = next;
    serialized = bytes;
    listeners.forEach((listener) => listener());
  };
  return {
    publish<K extends keyof WorkspaceFragments>(
      key: K,
      owner: symbol,
      read: () => WorkspaceFragments[K],
    ) {
      readers.set(key, { owner, read });
      refresh();
    },
    remove(key: keyof WorkspaceFragments, owner: symbol) {
      if (readers.get(key)?.owner !== owner) return;
      readers.delete(key);
      refresh();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      refresh();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          value = {};
          serialized = "{}";
        }
      };
    },
    getSnapshot: () => value,
  };
}

const registry = createSightlineWorkspaceRegistry();

/** Registration only while closed; projections and notifications belong to the visible consumer. */
export function usePublishSightline<K extends keyof WorkspaceFragments>(
  key: K,
  read: () => WorkspaceFragments[K],
) {
  const owner = useRef(Symbol(key));
  useLayoutEffect(() => {
    registry.publish(key, owner.current, read);
  });
  useLayoutEffect(() => {
    const identity = owner.current;
    return () => registry.remove(key, identity);
  }, [key]);
}

export function useSightlineWorkspaceInputs(): WorkspaceFragments {
  return useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
}
