import type { QueryClient } from "@tanstack/react-query";

/** Disabled Query observers do not expose invalidation as reactive result state. */
export function deploymentInvalidations(
  client: QueryClient,
  hashes: readonly string[],
): string {
  return hashes
    .map((hash) =>
      client.getQueryCache().get(hash)?.state.isInvalidated ? "1" : "0",
    )
    .join("");
}

/** Observe only the selected cached evidence; this never activates or fetches a query. */
export function subscribeDeploymentInvalidations(
  client: QueryClient,
  hashes: readonly string[],
  notify: () => void,
): () => void {
  const selected = new Set(hashes);
  let previous = deploymentInvalidations(client, hashes);
  return client.getQueryCache().subscribe((event) => {
    if (!selected.has(event.query.queryHash)) return;
    const next = deploymentInvalidations(client, hashes);
    if (next === previous) return;
    previous = next;
    notify();
  });
}
