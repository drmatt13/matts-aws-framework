import { useCallback, useEffect, useState } from "react";
import type { Mode } from "../shared/model";

export type ModeProfiles = Readonly<Partial<Record<Mode, string>>>;

export function parseModeProfiles(raw: string | null): ModeProfiles {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Partial<Record<Mode, string>> = {};
    for (const mode of ["dev", "prod"] as const) {
      const name = (value as Record<string, unknown>)[mode];
      if (typeof name === "string" && name.trim()) result[mode] = name;
    }
    return result;
  } catch { return {}; }
}

/** Cache only profile names, scoped to this checkout. Credentials stay on the machine. */
export function useAwsProfileSelection(repositoryRoot: string) {
  const key = `aws-studio:mode-profiles:v1:${repositoryRoot}`;
  const [profiles, setProfiles] = useState<ModeProfiles>(() => {
    try { return parseModeProfiles(window.localStorage.getItem(key)); } catch { return {}; }
  });
  const [cacheError, setCacheError] = useState(false);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setProfiles(parseModeProfiles(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);
  const setProfile = useCallback((mode: Mode, profile: string | undefined) => {
    // Merge against the latest cache so another tab's choice in the other mode survives.
    let latest = profiles;
    try { if (!cacheError) latest = parseModeProfiles(window.localStorage.getItem(key)); } catch { /* Session only. */ }
    const next = { ...latest };
    if (profile) next[mode] = profile;
    else delete next[mode];
    setProfiles(next);
    try { window.localStorage.setItem(key, JSON.stringify(next)); setCacheError(false); }
    catch { setCacheError(true); }
  }, [key, profiles, cacheError]);
  return { profiles, setProfile, cacheError };
}
