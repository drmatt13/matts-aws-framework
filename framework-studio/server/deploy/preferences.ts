import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DeployPreferences } from "../../shared/deploy";

/**
 * What Deploy & Run remembers between sessions on this machine: the profile
 * chosen for each deployment and the last selection. Names only; never a
 * credential. Kept in .cache, so it is never committed.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/;

export class Preferences {
  private readonly file: string;

  constructor(stateDirectory: string) {
    this.file = path.join(stateDirectory, "preferences.json");
  }

  read(): DeployPreferences {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DeployPreferences>;
      const profiles = Object.fromEntries(Object.entries(value.profiles ?? {}).filter(([key, profile]) => NAME.test(key) && typeof profile === "string" && NAME.test(profile)));
      return {
        profiles,
        ...(typeof value.profile === "string" && NAME.test(value.profile) ? { profile: value.profile } : {}),
        ...(typeof value.deployment === "string" && NAME.test(value.deployment) ? { deployment: value.deployment } : {}),
      };
    } catch {
      return { profiles: {} };
    }
  }

  update(patch: { readonly profile?: unknown; readonly deployment?: unknown }): DeployPreferences {
    const current = this.read();
    const profile = typeof patch.profile === "string" && NAME.test(patch.profile) ? patch.profile : undefined;
    const deployment = typeof patch.deployment === "string" && NAME.test(patch.deployment) ? patch.deployment : undefined;
    if (patch.profile !== undefined && !profile) throw Object.assign(new Error("A profile is a name from your AWS configuration."), { status: 400 });
    if (patch.deployment !== undefined && !deployment) throw Object.assign(new Error("That is not a deployment name."), { status: 400 });
    const next: DeployPreferences = {
      profiles: { ...current.profiles, ...(profile && (deployment ?? current.deployment) ? { [(deployment ?? current.deployment)!]: profile } : {}) },
      ...((profile ?? current.profile) ? { profile: profile ?? current.profile } : {}),
      ...((deployment ?? current.deployment) ? { deployment: deployment ?? current.deployment } : {}),
    };
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}
