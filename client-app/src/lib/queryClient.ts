import { QueryClient } from "@tanstack/react-query";
import { subscribeIdentityChange } from "#/lib/auth";

// Lives outside the React tree so non-component code -- logout, and the
// session-expiry effect in the authenticated layout -- can reach it.
export const appQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Drop every cached response. Order matters: cancelling first stops an
 * in-flight request from repopulating the cache after it is cleared.
 */
export async function clearReactQueryState(): Promise<void> {
  await appQueryClient.cancelQueries();
  await appQueryClient.invalidateQueries({ refetchType: "none" });
  appQueryClient.clear();
}

// Every cached response belongs to whoever was signed in when it was fetched.
// When that stops being true — a sign-out or expiry here or in another tab, or
// a different user's sign-in arriving from another tab — the cache goes with
// it, in one place, so no feature has to remember to do this itself.
subscribeIdentityChange(() => {
  void clearReactQueryState();
});
