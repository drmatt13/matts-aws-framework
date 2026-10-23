import type { IdentitySelection, IdentitySource } from "../shared/identity";
import { call } from "./api";

/** Shared read-only transport for authentication and production domains. */
export const identityApi = {
  source: async (mode: "dev" | "prod", signal?: AbortSignal) => {
    const result = await call<IdentitySource>(`/identity/source?mode=${mode}`, undefined, signal);
    if (!result || !result.inputs || typeof result.hash !== "string") throw new Error("Identity diagnostics are unavailable in the running server. Restart npm run studio in this checkout.");
    return result;
  },
  inspect: <T,>(kind: string, selection: IdentitySelection, nextToken?: string, search?: string, signal?: AbortSignal) => call<T>(`/identity/${kind}?${new URLSearchParams({ ...selection, ...(nextToken ? { nextToken } : {}), ...(search ? { search } : {}) })}`, undefined, signal),
};
