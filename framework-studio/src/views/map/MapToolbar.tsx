import type { RefObject } from "react";
import { Crosshair, Maximize2, Minus, PanelRight, Pause, Play, Plus, Search, X } from "lucide-react";
import type { Mode } from "../../../shared/model";
import type { SearchMatches } from "../../scene/focus";
import { tagValueLabel, UNTAGGED_FILTER, type TagGroup } from "../../tag-groups";
import { Select } from "../../ui/FormControls";
import { iconButtonClasses } from "../../ui/IconButton";
import { workspaceToolbarClasses } from "../../ui/Surface";
import { cx } from "../../ui/classes";
import { mapCameraButtonClasses } from "../map-styles";

interface MapToolbarProps {
  readonly search: {
    readonly query: string;
    readonly matches: SearchMatches | undefined;
    readonly selected: string | undefined;
    readonly inputRef: RefObject<HTMLInputElement | null>;
    readonly onChange: (query: string) => void;
    readonly onClearSelection: () => void;
  };
  readonly tags: {
    readonly key: string;
    readonly value: string | null | undefined;
    readonly enabled: boolean;
    readonly mode: Mode;
    readonly availableKeys: readonly string[];
    readonly groups: readonly TagGroup[];
    readonly untaggedCount: number;
    readonly matchCount: number;
    readonly keyRef: RefObject<HTMLSelectElement | null>;
    readonly onChange: (filter: { readonly key: string; readonly value?: string | null }) => void;
  };
  readonly camera: {
    readonly motion: boolean;
    readonly onZoom: (factor: number) => void;
    readonly onFit: () => void;
    readonly onFocus: () => void;
    readonly onToggleMotion: () => void;
  };
  readonly resources: {
    readonly open: boolean;
    readonly panelId: string;
    readonly onToggle: () => void;
  };
}

/** Presentation of map controls; the workspace retains every view-state transition. */
export function MapToolbar({ search, tags, camera, resources }: MapToolbarProps) {
  const { query, matches, selected, inputRef: searchRef, onChange: setQuery, onClearSelection: clearSelection } = search;
  const { key: activeTagKey, value: filterValue, enabled: tagging, mode, availableKeys: availableTagKeys,
    groups, untaggedCount, matchCount: tagMatchCount, keyRef: tagKeyRef, onChange: changeTagFilter } = tags;
  const { motion, onZoom: zoomBy, onFit: fit, onFocus: focus, onToggleMotion: toggleMotion } = camera;
  const { open: resourcesOpen, panelId, onToggle: toggleResources } = resources;
  const untaggedOnly = activeTagKey === UNTAGGED_FILTER;

  return (
    <div data-ui="workspace-toolbar landscape-top" className={cx(workspaceToolbarClasses, "flex flex-none flex-wrap items-start gap-x-3 gap-y-2")}>
      <div data-ui="landscape-search-panel" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 map-band:basis-full vp-700:basis-full">
        <div data-ui="landscape-search" className="flex min-h-(--control-height) w-[280px] max-w-full items-center gap-2 rounded-md border border-rule-strong bg-paper px-3 text-graphite focus-within:outline-2 focus-within:outline-prod focus-within:outline-offset-2 map-band:flex-[1_1_240px] vp-700:flex-[1_1_200px] [&>svg]:flex-none" role="search" aria-label="Map search">
          <Search size={16} aria-hidden />
          <input className="h-[calc(var(--control-height)-2px)] min-h-0 min-w-0 w-full border-0 bg-transparent p-0 font-[inherit] text-label text-ink outline-none placeholder:text-faint placeholder:opacity-100 [&::-webkit-search-cancel-button]:hidden" ref={searchRef} type="search" aria-label="Search isometric map" placeholder="Search the map…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            if (selected) clearSelection(); else setQuery("");
            event.preventDefault();
          }} />
          {/* Inside the field, so typing never changes the toolbar's height under the panel. */}
          {matches ? <span data-ui="landscape-search-count" className="inline-flex flex-none items-center gap-1 whitespace-nowrap text-caption text-graphite tabular-nums" role="status" title={selected ? "Search resumes when selection clears" : undefined}>
            {matches.nodes.size + matches.props.size} {matches.nodes.size + matches.props.size === 1 ? "match" : "matches"}
            {selected ? <><Pause size={11} aria-hidden /><span className="sr-only"> · Search resumes when selection clears</span></> : null}
          </span> : null}
          {query ? <button className={iconButtonClasses({ variant: "quiet", size: "compact", className: "-mr-2 text-inherit" })} aria-label="Clear map search" title="Clear map search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={14} aria-hidden /></button> : null}
        </div>
        <div data-ui="landscape-tag-controls" className="flex min-w-0 max-w-full flex-[0_1_auto] items-center gap-2 text-caption text-graphite vp-700:flex-[1_1_280px]" role="group" aria-label="Map tag filters"><label className="flex-none" htmlFor="map-tag-key">Tags</label>
          <Select className="w-[168px] flex-[0_1_168px]" ref={tagKeyRef} id="map-tag-key" aria-label="Filter map by tag key" title={untaggedOnly ? "Entities with no tags" : activeTagKey || "All tags"} value={activeTagKey} onChange={event => changeTagFilter({ key: event.target.value, ...(event.target.value === UNTAGGED_FILTER ? { value: null } : {}) })}>
            <option value="">All tags</option>
            <option value={UNTAGGED_FILTER} disabled={!tagging}>Untagged ({untaggedCount})</option>
            {activeTagKey && !untaggedOnly && !availableTagKeys.includes(activeTagKey) ? <option value={activeTagKey}>{activeTagKey} (unavailable in this mode)</option> : null}
            {availableTagKeys.map(key => <option key={key} value={key}>{key === "Untagged" ? "Untagged (key)" : key}</option>)}
          </Select>
          {/* Values belong to a chosen key; "All tags" and "Untagged" have none to pick. */}
          {activeTagKey && !untaggedOnly ? <Select className="w-[168px] flex-[0_1_168px]" aria-label="Filter map by tag value" title={filterValue === undefined ? "All values" : tagValueLabel(filterValue)} value={filterValue === undefined ? "all" : JSON.stringify(filterValue)} onChange={event => { const chosen = groups.find(group => JSON.stringify(group.value) === event.target.value); changeTagFilter({ key: activeTagKey, ...(chosen ? { value: chosen.value } : {}) }); }}><option value="all">All values</option>{filterValue !== undefined && !groups.some(group => group.value === filterValue) ? <option value={JSON.stringify(filterValue)}>{tagValueLabel(filterValue)} (no matches)</option> : null}{groups.map(group => <option key={JSON.stringify(group.value)} value={JSON.stringify(group.value)}>{tagValueLabel(group.value)} ({group.members.length})</option>)}</Select> : null}
          {activeTagKey ? <button className={iconButtonClasses({ variant: "quiet", className: "text-inherit" })} aria-label="Clear tag filter" title="Clear tag filter" onClick={() => { changeTagFilter({ key: "" }); tagKeyRef.current?.focus(); }}><X size={14} aria-hidden /></button> : null}
        </div>
        {/* The selects show the counts; the map's footer repeats the match, so the toolbar keeps one height. */}
        {activeTagKey && filterValue !== undefined ? <span className="sr-only" role="status">{tagMatchCount} matching {tagMatchCount === 1 ? "entity" : "entities"} in {mode === "dev" ? "development" : "production"}</span> : null}
      </div>
      <div data-ui="landscape-tools" className="inline-flex shrink-0 rounded-md border border-rule-strong bg-paper map-band:ml-auto vp-700:ml-auto" role="group" aria-label="Map view controls">
        <button className={mapCameraButtonClasses} onClick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (−)">
          <Minus size={16} aria-hidden />
        </button>
        <button className={mapCameraButtonClasses} onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (+)">
          <Plus size={16} aria-hidden />
        </button>
        <button className={mapCameraButtonClasses} onClick={() => fit()} aria-label="Fit the whole application" title="Fit everything (0)">
          <Maximize2 size={16} aria-hidden />
        </button>
        <button className={mapCameraButtonClasses} onClick={() => focus()} disabled={!selected} aria-label="Focus the selection" title="Focus the selection (F)">
          <Crosshair size={16} aria-hidden />
        </button>
        <button className={mapCameraButtonClasses} onClick={() => toggleMotion()} aria-pressed={!motion} aria-label={motion ? "Pause motion" : "Resume motion"} title={motion ? "Pause motion" : "Resume motion"}>
          {motion ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
        </button>
      </div>
      <button data-ui="panel-toggle" className="inline-flex min-h-(--control-height) flex-none cursor-pointer items-center gap-2 rounded-md border border-rule-strong bg-paper py-0 pr-3 pl-2 font-sans text-label leading-none font-medium text-graphite hover:bg-wash hover:text-ink aria-expanded:border-graphite aria-expanded:bg-wash aria-expanded:text-ink" onClick={toggleResources} aria-expanded={resourcesOpen} aria-controls={panelId} title={resourcesOpen ? "Hide resources" : "Browse resources by name and type"}>
        <PanelRight size={16} aria-hidden /><span>Resources</span>
      </button>
    </div>
  );
}
