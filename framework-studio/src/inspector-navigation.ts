import type { DisplayNames } from "./naming";
import { remapEntity } from "../shared/naming";
import { useLocation, useRouter } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef } from "react";

interface ElementPosition { readonly path: readonly number[]; readonly tag: string }
export interface InspectorPresentation {
  scrollTop: number;
  disclosures?: readonly (ElementPosition & { readonly open: boolean })[];
  focus?: ElementPosition;
}
interface Visit {
  readonly key: string;
  readonly position: number;
  readonly pathname: string;
  readonly selected: string | undefined;
  readonly parent?: string;
  readonly origin?: string;
  label: string;
  readonly presentations: Map<string, InspectorPresentation>;
  readonly focus: boolean;
}
export interface InspectorNavigation {
  readonly key: string;
  readonly selected: string | undefined;
  readonly origin: string | undefined;
  readonly previous: { readonly id: string; readonly label: string } | undefined;
  readonly presentation: InspectorPresentation;
  readonly restore: boolean;
  readonly focus: boolean;
  readonly back: () => void;
}

/** Only accepted router locations become visits. Presentation stays in memory, never in URLs or history state. */
export function useInspectorNavigation(options: {
  selected: string | undefined;
  aliases?: DisplayNames;
  ready: boolean;
  mode: string;
  label: (id: string) => string;
  select: (id: string | undefined) => void;
  requestNavigation: (proceed: () => void) => void;
}) {
  const router = useRouter();
  const location = useLocation();
  const visits = useRef(new Map<string, Visit>());
  const current = useRef<Visit | undefined>(undefined);
  const pending = useRef<{ from: string; selected: string | undefined; root: boolean; focus: boolean } | undefined>(undefined);
  const cancel = useCallback(() => { pending.current = undefined; }, []);
  const restoring = useRef(false);
  const appliedAliases = useRef<DisplayNames | undefined>(undefined);
  if (options.aliases && appliedAliases.current !== options.aliases) {
    const rename = (id: string | undefined) => id ? remapEntity(id, options.aliases!) : id;
    const keys = new Map([...visits.current].map(([key, visit]) => [key, visit.selected ? key.slice(0, -visit.selected.length) + rename(visit.selected) : key]));
    const updated = new Map<string, Visit>();
    for (const [key, old] of visits.current) {
      const selected = rename(old.selected);
      const label = selected && selected !== old.selected ? options.label(selected) : undefined;
      const visit = { ...old, key: keys.get(key)!, selected, origin: rename(old.origin), parent: old.parent ? keys.get(old.parent) ?? old.parent : undefined, label: label && label !== selected ? label : old.label };
      updated.set(visit.key, visit);
      if (current.current === old) current.current = visit;
    }
    visits.current = updated;
    if (pending.current) pending.current = { ...pending.current, from: keys.get(pending.current.from) ?? pending.current.from, selected: rename(pending.current.selected) };
    appliedAliases.current = options.aliases;
  }
  useLayoutEffect(() => {
    if (!options.ready || !options.selected) return;
    const label = document.querySelector('[data-slot="inspector-content"] h2')?.textContent?.trim();
    if (label) for (const visit of visits.current.values()) if (visit.selected === options.selected) visit.label = label;
  });
  const key = `${location.state.__TSR_key ?? location.state.key ?? location.state.__TSR_index}:${options.selected ?? ""}`;
  const routedSelection = options.selected;
  if (options.ready && routedSelection === options.selected && current.current?.key !== key) {
    const previous = current.current;
    let visit = visits.current.get(key);
    // Replacing a renamed URL keeps its history position and Inspector presentation.
    if (!visit && previous?.position === location.state.__TSR_index && previous.pathname === location.pathname && previous.selected === options.selected) {
      visit = { ...previous, key };
      visits.current.set(key, visit);
    }
    restoring.current = !!visit;
    if (!visit) {
      const intent = pending.current;
      const related = !!intent && !!previous && intent.from === previous.key && intent.selected === options.selected && !intent.root
        && previous.pathname === location.pathname && previous.selected !== undefined && options.selected !== undefined;
      visit = { key, position: location.state.__TSR_index, pathname: location.pathname, selected: options.selected,
        ...(related ? { parent: previous.key } : {}),
        origin: related ? previous.origin : options.selected,
        label: options.selected ? options.label(options.selected) : "Resources", presentations: new Map(), focus: intent?.focus ?? false };
      visits.current.set(key, visit);
      // Keep presentation memory bounded for long editing sessions. Missing ancestors simply end the trail.
      if (visits.current.size > 200) visits.current.delete(visits.current.keys().next().value!);
    }
    current.current = visit;
    pending.current = undefined;
  }
  // The draft synchronizes selection in a layout effect; keep the outgoing visit until it has done so.
  const visit = current.current ?? { key, position: location.state.__TSR_index, pathname: location.pathname,
    selected: options.selected, origin: options.selected, label: "Resources", presentations: new Map<string, InspectorPresentation>(), focus: false };
  let presentation = visit.presentations.get(options.mode);
  if (!presentation) { presentation = { scrollTop: 0 }; visit.presentations.set(options.mode, presentation); }
  const parent = visit.parent ? visits.current.get(visit.parent) : undefined;
  const prepare = (id: string | undefined, root: boolean, focus: boolean) => {
    if (id === options.selected) return;
    const content = document.querySelector<HTMLElement>('[data-slot="inspector-content"]');
    if (content) {
      captureInspectorPresentation(content, presentation);
      visit.label = content.querySelector("h2")?.textContent?.trim() || visit.label;
    }
    pending.current = { from: visit.key, selected: id, root, focus };
    options.select(id);
  };
  return {
    navigation: { key: visit.key, selected: visit.selected, origin: visit.origin,
      previous: parent?.selected ? { id: parent.selected, label: parent.label } : undefined,
      presentation, restore: restoring.current, focus: visit.focus,
      back: () => {
        if (!parent?.selected) return;
        const distance = parent.position - visit.position;
        if (distance < 0) options.requestNavigation(() => router.history.go(distance));
        else prepare(parent.selected, true, true);
      },
    } satisfies InspectorNavigation,
    select: (id: string | undefined) => prepare(id, false, id !== undefined),
    inspect: (id: string, focus = false) => prepare(id, true, focus),
    cancel,
  };
}

function position(root: HTMLElement, element: Element): ElementPosition | undefined {
  const path: number[] = [];
  let child = element;
  while (child !== root) {
    const parent = child.parentElement;
    if (!parent) return;
    path.unshift([...parent.children].indexOf(child));
    child = parent;
  }
  return { path, tag: element.tagName };
}
function atPosition(root: HTMLElement, saved: ElementPosition): HTMLElement | undefined {
  let element: Element = root;
  for (const index of saved.path) { const child = element.children.item(index); if (!child) return; element = child; }
  return element.tagName === saved.tag ? element as HTMLElement : undefined;
}

/** Structural positions and open/scroll state only: never retain form values, text, or detached DOM nodes. */
export function captureInspectorPresentation(root: HTMLElement, state: InspectorPresentation) {
  // Browsers reset a detached scroll container to zero. Its last connected snapshot is authoritative.
  if (!root.isConnected) return;
  state.scrollTop = root.scrollTop;
  state.disclosures = [...root.querySelectorAll("details")].map(element => ({ ...position(root, element)!, open: element.open }));
  if (document.activeElement && root.contains(document.activeElement)) state.focus = position(root, document.activeElement);
}

export function restoreInspectorPresentation(root: HTMLElement, state: InspectorPresentation): HTMLElement | undefined {
  for (const saved of state.disclosures ?? []) {
    const element = atPosition(root, saved);
    if (element?.tagName === "DETAILS") (element as HTMLDetailsElement).open = saved.open;
  }
  root.scrollTop = state.scrollTop;
  return state.focus ? atPosition(root, state.focus) : undefined;
}
