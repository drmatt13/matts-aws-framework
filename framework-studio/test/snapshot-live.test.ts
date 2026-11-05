import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import assert from "./support/assert";
import { connectionGeneration } from "../src/connection-generations";
import type { LiveState } from "../src/snapshot";
import type { AwsConnectionObservation } from "../shared/aws-connections";

test("global lifecycle events scope identity invalidation and reconnect generations reject late checks", async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM('<html><head><meta name="studio-token" content="generation-test"></head><body></body></html>', { url: "http://localhost", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver"] as const)
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  let networkReads = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => {
    networkReads++;
    throw new Error("Passive lifecycle reconciliation must not check identity.");
  } });
  const streams: { emit(type: string, data: unknown): void }[] = [];
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class {
    readonly listeners = new Map<string, Set<EventListener>>();
    constructor() { streams.push(this); }
    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? new Set<EventListener>();
      listeners.add(listener); this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
    close() { this.listeners.clear(); }
    emit(type: string, data: unknown) {
      const event = { data: JSON.stringify(data) } as unknown as Event;
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  } });
  const { QueryClient, QueryClientProvider } = require("@tanstack/react-query") as typeof import("@tanstack/react-query");
  const { useLiveUpdates, deploymentSourceRevision } = await import("../src/snapshot");
  const { awsProfileIdentityQuery } = await import("../src/aws-profile-queries");
  const ui = await import("@testing-library/react");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const identity = (profile: string): AwsConnectionObservation => ({
    profile, revision: "configuration", state: "connected", region: { value: "us-east-1", source: "profile" },
    identity: { account: "123456789012", arn: "arn:aws:iam::123456789012:user/test", principalKind: "user", summary: "test" },
  });
  let live: LiveState = { connected: false, evaluating: false, running: null };
  let currentSnapshotRevision = "source-1";
  function Observer() { live = useLiveUpdates(() => {}, currentSnapshotRevision); return null; }
  const mounted = ui.render(createElement(QueryClientProvider, { client }, createElement(Observer)));
  try {
    const sharedKey = awsProfileIdentityQuery("shared").queryKey;
    const otherKey = awsProfileIdentityQuery("other").queryKey;
    client.setQueryData(sharedKey, identity("shared"));
    client.setQueryData(otherKey, identity("other"));
    let finish!: (value: AwsConnectionObservation) => void;
    const pending = client.fetchQuery({ ...awsProfileIdentityQuery("shared"), staleTime: 0,
      queryFn: () => new Promise<AwsConnectionObservation>(resolve => { finish = resolve; }) }).catch(() => undefined);
    ui.act(() => streams[0]!.emit("hello", {}));
    assert.equal(connectionGeneration(live, "shared"), "0:0", "initial hello does not discard startup reads");
    ui.act(() => streams[0]!.emit("aws-connections", { profiles: ["shared"] }));
    assert.equal(connectionGeneration(live, "shared"), "0:1");
    assert.equal(connectionGeneration(live, "other"), "0:0");
    assert.equal(client.getQueryData<AwsConnectionObservation>(otherKey)?.state, "connected");
    assert.equal(client.getQueryData<AwsConnectionObservation>(sharedKey)?.state, "unchecked");
    assert.equal(client.getQueryData<AwsConnectionObservation>(sharedKey)?.lastKnownIdentity?.account, "123456789012");
    await ui.act(async () => { finish(identity("shared")); await pending; });
    assert.equal(client.getQueryData<AwsConnectionObservation>(sharedKey)?.state, "unchecked", "late cancelled identity cannot restore current evidence");
    const currentKey = awsProfileIdentityQuery("shared", connectionGeneration(live, "shared")).queryKey;
    const historical = client.getQueryData<AwsConnectionObservation>(currentKey);
    assert.equal(historical?.state, "unchecked");
    assert.equal(historical?.identity, undefined, "historical identity is never current verification");
    assert.equal(historical?.lastKnownIdentity?.summary, "test", "the configuration dialog can display last verified (stale)");
    assert.equal(client.getQueryState(currentKey)?.dataUpdatedAt, 0, "a stale seed cannot suppress an active identity check");
    client.setQueryData(sharedKey, { ...identity("shared"), identity: { ...identity("shared").identity!, summary: "late actor" } });
    assert.equal(client.getQueryData<AwsConnectionObservation>(currentKey)?.lastKnownIdentity?.summary, "test", "explicit late writes stay in their captured generation");
    ui.act(() => {
      streams[0]!.emit("aws-connections", { profiles: ["shared"] });
      streams[0]!.emit("aws-connections", { profiles: ["shared"] });
    });
    assert.equal(connectionGeneration(live, "shared"), "0:3", "batched events each advance the captured epoch");
    assert.equal(client.getQueryData<AwsConnectionObservation>(awsProfileIdentityQuery("shared", "0:3").queryKey)?.lastKnownIdentity?.summary, "test");
    ui.act(() => streams[0]!.emit("snapshot", { revision: "source-2", external: [] }));
    assert.equal(live.sourcePublicationRevision, "source-2");
    assert.equal(live.sourcePublicationBaseRevision, "source-1");
    assert.equal(deploymentSourceRevision("source-1", live), "source-2", "existing and newly mounted consumers use the publication while snapshot refresh is pending or failed");
    assert.equal(deploymentSourceRevision("source-2", live), "source-2");
    currentSnapshotRevision = "source-3";
    mounted.rerender(createElement(QueryClientProvider, { client }, createElement(Observer)));
    assert.equal(deploymentSourceRevision(currentSnapshotRevision, live), "source-3", "a reconnect snapshot can supersede a missed publication");
    ui.act(() => streams[0]!.emit("error", {}));
    assert.equal(live.connected, false);
    ui.act(() => streams[0]!.emit("hello", {}));
    assert.equal(connectionGeneration(live, "shared"), "1:0");
    assert.equal(connectionGeneration(live, "other"), "1:0");
    assert.equal(live.reconnectRevision, 1);
    assert.equal(live.awsConnectionRevision, 4);
    assert.equal(client.getQueryData<AwsConnectionObservation>(otherKey)?.state, "unchecked");
    assert.equal(client.getQueryData<AwsConnectionObservation>(awsProfileIdentityQuery("other", "1:0").queryKey)?.lastKnownIdentity?.summary, "test");
    assert.equal(networkReads, 0, "an unassociated lifecycle event only retains stale identity evidence");
    assert.equal(streams.length, 1, "reconciliation retains the shared transport");
  } finally {
    mounted.unmount(); client.clear(); dom.window.close();
  }
});
