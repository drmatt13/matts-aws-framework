import { AlertTriangle } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { Prop, Scene, SceneNode } from "../scene/build";
import type { IconKey } from "../icons";
import { EntityIcon } from "./EntityIcon";

/** Where the list was when the inspector replaced it, so Back returns to the same place and row. */
export interface BrowserMemory { scrollTop: number; returnTo?: string | undefined }

interface Row { readonly id: string; readonly icon: IconKey; readonly badge?: IconKey; readonly label: string; readonly detail: string; readonly muted: boolean; readonly attention: boolean }
interface Group { readonly id: string; readonly title: string; readonly rows: readonly Row[] }

/** "Stack member, ITable" reads as "Stack member · ITable"; an empty qualifier is dropped. */
function detailOf(node: SceneNode): string {
  const [kind, ...qualifier] = node.kindLabel.split(", ");
  return [kind, qualifier.join(", "), node.tagFiltered ? "Outside tag filter" : ""].filter(Boolean).join(" · ");
}

/**
 * The searchable list of map resources, grouped by the island each one stands on so the
 * list and the map share one spatial order. Search and the type filter narrow it; neither
 * moves nodes or changes infrastructure identity.
 */
export function ResourceBrowser(props: {
  readonly scene: Scene;
  /** Resources the search and type filter keep, in reading order. */
  readonly nodes: readonly SceneNode[];
  /** Network fixtures matching the search; listed only while searching. */
  readonly fixtures: readonly Prop[];
  readonly total: number;
  readonly kinds: readonly string[];
  readonly kind: string;
  readonly onKind: (kind: string) => void;
  readonly filtered: boolean;
  readonly onClearFilters: () => void;
  readonly attention: (id: string) => boolean;
  readonly onInspect: (id: string) => void;
  /** Transient map emphasis; never opens an inspector or changes the camera. */
  readonly onPreview: (id: string | undefined) => void;
  readonly memory: RefObject<BrowserMemory>;
}) {
  const { scene, nodes, fixtures, attention, memory } = props;
  const list = useRef<HTMLDivElement>(null);
  const [pointed, setPointed] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const preview = pointed ?? focused;
  const { onPreview } = props;
  useLayoutEffect(() => { onPreview(preview); }, [onPreview, preview]);
  useLayoutEffect(() => () => onPreview(undefined), [onPreview]);
  // Filtering or a new source snapshot must not retain a row that disappeared.
  useLayoutEffect(() => {
    const present = (id: string | undefined) => nodes.some(node => node.id === id) || fixtures.some(prop => prop.id === id);
    setPointed(id => present(id) ? id : undefined);
    setFocused(id => present(id) ? id : undefined);
  }, [nodes, fixtures]);
  const groups = useMemo(() => {
    const rowOf = (node: SceneNode): Row => ({ id: node.id, icon: node.icon, ...(node.roleIcon ? { badge: node.roleIcon } : {}), label: node.label, detail: detailOf(node), muted: !!node.tagFiltered, attention: attention(node.id) });
    const byIsland = new Map<string, Row[]>();
    for (const node of nodes) byIsland.set(node.island, [...byIsland.get(node.island) ?? [], rowOf(node)]);
    const groups: Group[] = [];
    for (const island of scene.islands) {
      const rows = byIsland.get(island.id);
      if (!rows) continue;
      byIsland.delete(island.id);
      groups.push({ id: island.id, title: island.id.startsWith("island:vpc:") ? `VPC ${island.title}` : island.title, rows });
    }
    const unplaced = [...byIsland.values()].flat();
    if (unplaced.length) groups.push({ id: "other", title: "Other", rows: unplaced });
    if (fixtures.length) groups.push({ id: "fixtures", title: "Network fixtures", rows: fixtures.map(prop => ({ id: prop.id, icon: prop.icon, label: prop.label, detail: "Network fixture", muted: !!prop.tagFiltered, attention: false })) });
    return groups;
  }, [scene, nodes, fixtures, attention]);

  // Return to the scroll position the inspector replaced, and to the row it opened.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    element.scrollTop = memory.current.scrollTop;
    const returnTo = memory.current.returnTo;
    memory.current.returnTo = undefined;
    const row = returnTo ? [...element.querySelectorAll<HTMLElement>("[data-resource-id]")].find(candidate => candidate.dataset.resourceId === returnTo) : undefined;
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
  }, [memory]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".resource-row")];
    const current = rows.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, current + 1) : event.key === "ArrowUp" ? Math.max(0, current - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    rows[next]!.focus();
  };

  const shown = nodes.length;
  return (
    <>
      <div className="resource-browser-filters">
        <select aria-label="Map resource type" value={props.kind} onChange={event => props.onKind(event.target.value)}>
          <option value="">All types</option>
          {props.kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        {props.filtered ? <p className="resource-browser-status" role="status">
          <span>{shown} of {props.total} resources</span>
          <button className="linkish" onClick={props.onClearFilters}>Clear filters</button>
        </p> : null}
      </div>
      <div className="resource-browser-list" ref={list} onScroll={event => { memory.current.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={onKeyDown}>
        {groups.map(group => (
          <section key={group.id} className="resource-group" aria-labelledby={`resource-group-${group.id}`}>
            <h3 id={`resource-group-${group.id}`}><span title={group.title}>{group.title}</span><span className="resource-group-count">{group.rows.length}</span></h3>
            <ul>
              {group.rows.map(row => (
                <li key={row.id}>
                  <button className={`resource-row${row.muted ? " outside-filter" : ""}${preview === row.id ? " previewing" : ""}`} data-resource-id={row.id}
                    onPointerEnter={event => { if (event.pointerType !== "touch") setPointed(row.id); }} onPointerLeave={() => setPointed(undefined)} onPointerCancel={() => setPointed(undefined)}
                    onFocus={() => setFocused(row.id)} onBlur={() => setFocused(undefined)}
                    onClick={() => props.onInspect(row.id)} title={row.label === row.id ? row.label : `${row.label}\n${row.id}`}>
                    <span className="resource-row-icon" aria-hidden><EntityIcon icon={row.icon} {...(row.badge ? { badge: row.badge } : {})} /></span>
                    <span className="resource-row-text"><strong>{row.label}</strong><span>{row.detail}</span></span>
                    {row.attention ? <span className="resource-row-attention" title="Needs attention"><AlertTriangle size={14} aria-hidden /><span className="sr-only">Needs attention</span></span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {!groups.length ? <div className="resource-browser-empty">
          <p>No resources match.</p>
          {props.filtered ? <button className="quiet" onClick={props.onClearFilters}>Clear filters</button> : null}
        </div> : null}
        <p className="resource-browser-note">The map shows declarations; Deploy shows running state.</p>
      </div>
    </>
  );
}
