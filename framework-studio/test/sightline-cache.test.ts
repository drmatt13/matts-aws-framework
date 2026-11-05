import assert from "./support/assert";
import { test } from "node:test";
import { hashKey, QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  deploymentInvalidations,
  subscribeDeploymentInvalidations,
} from "../src/sightline/cache";

test("Sightline observes exact cache invalidation without activating disabled reads", async () => {
  const client = new QueryClient();
  const dev = ["deploy", "status", { mode: "dev" }],
    prod = ["deploy", "status", { mode: "prod" }];
  const hashes = [hashKey(dev), hashKey(prod)];
  let reads = 0,
    observerUpdates = 0;
  client.setQueryData(dev, { observedAt: "earlier" });
  client.setQueryData(prod, { observedAt: "earlier" });
  const observer = new QueryObserver(client, {
    queryKey: dev,
    queryFn: async () => {
      reads++;
      return { observedAt: "later" };
    },
    enabled: false,
  });
  const stopObserver = observer.subscribe(() => observerUpdates++);
  const result = observer.trackResult(observer.getCurrentResult());
  void result.data;
  void result.error;
  void result.isError;
  void result.dataUpdatedAt;
  void result.isFetching;
  const changes: string[] = [];
  const stop = subscribeDeploymentInvalidations(client, hashes, () =>
    changes.push(deploymentInvalidations(client, hashes)),
  );
  assert.equal(deploymentInvalidations(client, hashes), "00");
  await client.invalidateQueries({ queryKey: dev, exact: true });
  assert.equal(
    observerUpdates,
    0,
    "Disabled QueryObserver result alone cannot report invalidation.",
  );
  assert.deepEqual(changes, ["10"]);
  await client.invalidateQueries({ queryKey: prod, exact: true });
  assert.deepEqual(changes, ["10", "11"]);
  client.setQueryData(dev, { observedAt: "later" });
  assert.deepEqual(changes, ["10", "11", "01"]);
  assert.equal(reads, 0);
  stop();
  stopObserver();
  client.clear();
});

test("Sightline ignores unrelated cache changes and unsubscribes when its view closes", async () => {
  const client = new QueryClient();
  const key = ["deploy", "status", { mode: "dev" }],
    other = ["private-input-details"];
  client.setQueryData(key, { observedAt: "earlier" });
  client.setQueryData(other, { value: "excluded" });
  let notifications = 0;
  const stop = subscribeDeploymentInvalidations(
    client,
    [hashKey(key)],
    () => notifications++,
  );
  await client.invalidateQueries({ queryKey: other });
  client.setQueryData(key, { observedAt: "later" });
  assert.equal(notifications, 0);
  await client.invalidateQueries({ queryKey: key });
  assert.equal(notifications, 1);
  stop();
  client.setQueryData(key, { observedAt: "latest" });
  await client.invalidateQueries({ queryKey: key });
  assert.equal(notifications, 1);
  client.clear();
});
