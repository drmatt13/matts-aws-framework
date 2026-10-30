import type { ModeModel, Snapshot } from "../shared/model";
import { remapEntity } from "../shared/naming";

export type DisplayNames = Readonly<Record<string, string>>;
type NamedModel = ModeModel & { readonly displayNames?: DisplayNames };

/** Presentation metadata never changes catalog paths, target ids, or source intent. */
export function namesOf(model: ModeModel): DisplayNames { return (model as NamedModel).displayNames ?? {}; }
export function displayName(model: ModeModel, entity: string, fallback: string): string {
  if (entity.startsWith("island:vpc:")) return fallback;
  return namesOf(model)[entity] ?? fallback;
}
export function presentedSnapshot(snapshot: Snapshot): Snapshot {
  const values = Object.fromEntries(Object.entries(snapshot.displayNames?.values ?? {}).filter(([id]) => !id.startsWith("island:vpc:")));
  if (!values || !Object.keys(values).length) return snapshot;
  return { ...snapshot, models: { dev: { ...snapshot.models.dev, displayNames: values } as NamedModel, prod: { ...snapshot.models.prod, displayNames: values } as NamedModel } };
}

/** Remap only URLs already visited when a rename was accepted. A fresh history
 * entry may legitimately reuse an old identity, and rename cycles remain valid. */
export class NamingHistory {
  private readonly entries = new Map<string, { raw: string | undefined; selected: string | undefined }>();
  selection(key: string, raw: string | undefined): string | undefined {
    const entry = this.entries.get(key);
    const selected = entry && entry.raw === raw ? entry.selected : raw;
    this.entries.set(key, { raw, selected });
    if (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
    return selected;
  }
  accept(remap: DisplayNames): void {
    for (const [key, entry] of this.entries) this.entries.set(key, { ...entry, selected: entry.selected ? remapEntity(entry.selected, remap) : undefined });
  }
}
