import type { IdentitySelection, IdentitySource } from "../shared/identity";
import { call } from "./api";

/** Keep server diagnostics intact while making browser transport failures actionable. */
export function inspectionErrorMessage(reason: unknown): string {
  if (reason instanceof TypeError && /^(Failed to fetch|fetch failed|Load failed|Network request failed|NetworkError when attempting to fetch resource\.?)$/i.test(reason.message.trim())) {
    return `Inspection could not reach Studio. Check the Studio connection, then retry inspection. Details: ${reason.message}`;
  }
  return reason instanceof Error && reason.message ? reason.message : "Inspection failed. Retry inspection.";
}

/** Shared read-only transport for authentication and production domains. */
export const identityApi = {
  source: async (mode: "dev" | "prod", signal?: AbortSignal) => {
    const result = await call<IdentitySource>(`/identity/source?mode=${mode}`, undefined, signal);
    if (!result || !result.inputs || typeof result.hash !== "string") throw new Error("Identity diagnostics are unavailable in the running server. Restart npm run studio in this checkout.");
    return result;
  },
  inspect: <T,>(kind: string, selection: IdentitySelection, nextToken?: string, search?: string, signal?: AbortSignal) => call<T>(`/identity/${kind}?${new URLSearchParams({ ...selection, ...(nextToken ? { nextToken } : {}), ...(search ? { search } : {}) })}`, undefined, signal),
};
