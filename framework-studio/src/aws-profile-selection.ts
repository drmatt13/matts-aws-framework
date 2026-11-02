import { useCallback, useEffect, useRef, useState } from "react";
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
  const sessionProfiles = useRef(profiles);
  const storageUnavailable = useRef(false);
  sessionProfiles.current = profiles;
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        const next = parseModeProfiles(event.newValue);
        sessionProfiles.current = next;
        setProfiles(next);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);
  const setProfile = useCallback((mode: Mode, profile: string | undefined) => {
    // Merge against the latest cache so another tab's choice in the other mode survives.
    let latest = sessionProfiles.current;
    try { if (!storageUnavailable.current) latest = parseModeProfiles(window.localStorage.getItem(key)); } catch { storageUnavailable.current = true; }
    const next = { ...latest };
    if (profile) next[mode] = profile;
    else delete next[mode];
    sessionProfiles.current = next;
    setProfiles(next);
    try { window.localStorage.setItem(key, JSON.stringify(next)); storageUnavailable.current = false; setCacheError(false); }
    catch { storageUnavailable.current = true; setCacheError(true); }
  }, [key]);
  return { profiles, setProfile, cacheError };
}
