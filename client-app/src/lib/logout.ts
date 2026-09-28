import { API_ROUTE } from "@repo/api-contract";
import { invalidateAuthCache } from "#/lib/auth";
import { clearReactQueryState } from "#/lib/queryClient";

const API_URL = "/api";

function getApiUrl(): string {
  return API_URL;
}

export default async function logout(): Promise<void> {
  if (typeof document === "undefined") {
    return;
  }

  invalidateAuthCache({ broadcast: true });

  try {
    await fetch(`${getApiUrl()}${API_ROUTE["/sign-out"]}`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // Network errors must not block local cleanup and redirect.
  } finally {
    invalidateAuthCache({ broadcast: false });
    // After the request settles, so a query that resolved mid-flight cannot
    // leave the previous user's data in the cache.
    await clearReactQueryState();
  }
}
