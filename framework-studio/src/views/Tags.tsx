import { Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MAX_DECLARATION_TAGS, validateTags } from "@repo/framework/config/tags";
import { api, ApiError } from "../api";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";
import { InspectorDisclosure } from "./InspectorUI";

type Tags = Readonly<Record<string, string>>;
const entries = (value: Tags) => Object.entries(value).map(([key, value]) => ({ key, value }));
const validTagPart = (key: string, value: string) => {
  try { validateTags({ [key]: value }); return true; } catch { return false; }
};

/** One key/value control for creation and reviewed declaration edits. */
export function TagRows({ value, onChange, disabled = false }: { readonly value: Tags; readonly onChange: (tags: Tags, error?: string) => void; readonly disabled?: boolean }) {
  const prefix = useId();
  const editor = useRef<HTMLDivElement>(null);
  const focusNewRow = useRef(false);
  const focusAfterRemove = useRef<number | undefined>(undefined);
  const [rows, setRows] = useState(() => entries(value));
  const [problem, setProblem] = useState<string>();
  const signature = JSON.stringify(value);
  useEffect(() => {
    if (JSON.stringify(Object.fromEntries(rows.map(row => [row.key, row.value]))) !== signature) { setRows(entries(value)); setProblem(undefined); }
  }, [signature]);
  useEffect(() => {
    if (focusNewRow.current) {
      editor.current?.querySelector<HTMLInputElement>(".tag-row:last-of-type input")?.focus();
      focusNewRow.current = false;
    } else if (focusAfterRemove.current !== undefined) {
      const row = editor.current?.querySelectorAll<HTMLElement>(".tag-row")[focusAfterRemove.current];
      (row?.querySelector<HTMLInputElement>("input") ?? editor.current?.querySelector<HTMLButtonElement>(".tag-add"))?.focus();
      focusAfterRemove.current = undefined;
    }
  }, [rows.length]);
  const update = (next: typeof rows, adding = false) => {
    setRows(next);
    const tags = Object.fromEntries(next.map(row => [row.key, row.value]));
    let error: string | undefined;
    if (new Set(next.map(row => row.key)).size !== next.length) error = "Each tag key must be unique.";
    try { validateTags(tags, "Tags"); } catch (reason) { error ??= reason instanceof Error ? reason.message : String(reason); }
    // A newly added empty row is ready for typing; validation still blocks review.
    setProblem(adding ? problem : error); onChange(tags, error);
  };
  return <div className="tag-editor" ref={editor}>
    {rows.length ? <div className="tag-column-labels" aria-hidden="true"><span>Key</span><span>Value</span><span /></div> : <p className="small muted tag-empty">Add a tag to set a key and value.</p>}
    {rows.map((row, index) => <div className="tag-row" key={index}>
      <label className="sr-only" htmlFor={`${prefix}-${index}-key`}>Tag {index + 1} key</label><input id={`${prefix}-${index}-key`} value={row.key} placeholder="Key" disabled={disabled} autoComplete="off" spellCheck={false} aria-invalid={!!problem && (!validTagPart(row.key, "") || rows.some((other, at) => at !== index && other.key === row.key))} aria-describedby={problem ? `${prefix}-problem` : undefined} onChange={event => update(rows.map((item, at) => at === index ? { ...item, key: event.target.value } : item))} />
      <label className="sr-only" htmlFor={`${prefix}-${index}-value`}>Tag {index + 1} value</label><input id={`${prefix}-${index}-value`} value={row.value} placeholder="Value" disabled={disabled} autoComplete="off" spellCheck={false} aria-invalid={!!problem && !validTagPart("Tag", row.value)} aria-describedby={problem ? `${prefix}-problem` : undefined} onChange={event => update(rows.map((item, at) => at === index ? { ...item, value: event.target.value } : item))} />
      <button type="button" className="quiet tag-delete" disabled={disabled} aria-label={`Remove tag ${row.key || index + 1}`} onClick={() => { focusAfterRemove.current = Math.max(0, Math.min(index, rows.length - 2)); update(rows.filter((_, at) => at !== index)); }}><Trash2 size={13} aria-hidden /><span>Delete</span></button>
    </div>)}
    <button type="button" className="quiet tag-add" disabled={disabled || rows.length >= MAX_DECLARATION_TAGS} onClick={() => { focusNewRow.current = true; update([...rows, { key: "", value: "" }], true); }}><Plus size={13} aria-hidden /> Add tag</button>
    {problem ? <p className="reason small" role="status" id={`${prefix}-problem`}>{problem}</p> : null}
  </div>;
}

/** Recover an open page's old snapshot without guessing whether source is editable. */
function RefreshTagEditor({ entity }: { readonly entity: string }) {
  const { draft, draftState, live } = useStudio();
  const query = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const refresh = async () => {
    setBusy(true); setProblem(undefined);
    try {
      const response = await api.snapshot();
      query.setQueryData(["snapshot"], response);
      if (!response.snapshot.source.editability[entity]?.tags) setProblem("This server needs restarting to enable tag editing. Restart npm run studio, then refresh the editor.");
    } catch (error) {
      // Restarting Studio changes its session token. A fresh page reconnects safely.
      if (error instanceof ApiError && error.status === 401) draft.requestNavigation(() => window.location.reload());
      else setProblem(error instanceof Error ? error.message : "Could not refresh the editor. Try again.");
    } finally { setBusy(false); }
  };
  return <div className="tag-editor-refresh">
    <p className="small muted">{draft.dirty ? "Apply or discard your current changes before refreshing tag editing." : "Refresh to load tag editing for this declaration."}</p>
    <button type="button" className="quiet" disabled={busy || draft.dirty || !!draftState.busy || live.evaluating} onClick={() => void refresh()}><RotateCw size={13} aria-hidden />{busy ? "Refreshing…" : "Refresh editor"}</button>
    {problem ? <p className="reason small" role="status">{problem}</p> : null}
  </div>;
}

/** Catalog members show inheritance; removal restores a producer's value. */
export function Tags({ entity, route = false }: { readonly entity: string; readonly route?: boolean }) {
  const { model, snapshot, draft, draftState, live, select } = useStudio();
  const facts = model.tagging?.[entity];
  if (!facts) {
    const resource = model.resources.find(resource => resource.id === entity);
    const known = model.targets.some(target => target.ref === entity) || resource || model.networks?.some(network => `island:vpc:${network.id}` === entity) || (model.managedDatabase && `database:${model.managedDatabase.id}` === entity);
    if (!known) return null;
    const generated = resource && (resource.frameworkStack || resource.kind === "envFile" || resource.kind === "group" || resource.deploymentFile || resource.clientEnvironment);
    return <InspectorDisclosure title="Tags" className="declaration-tags">{generated || model.tagging ? <p className="small muted">This generated or logical resource has no independently authored tag declaration. Its producing declaration owns its tags; follow the source link above.</p> : <RefreshTagEditor entity={entity} />}</InspectorDisclosure>;
  }
  const editability = snapshot.source.editability[entity]?.tags;
  const editable = editability?.kind === "literal" || editability?.kind === "absent";
  const reason = editability?.kind === "unsupported" ? editability.reason : editability?.kind === "computed" || editability?.kind === "spread" ? "Tags are computed in source. Edit the expression in your editor." : "This declaration's tags are edited in source.";
  const current = draft.tags(entity);
  const inheritedSource = facts.inherited?.entity ?? Object.values(facts.provenance).find(value => value.kind === "inherited")?.entity ?? model.resources.find(resource => resource.id === entity)?.parent;
  const inherited = Object.entries(facts.inherited?.values ?? (inheritedSource ? model.tagging?.[inheritedSource]?.effective ?? {} : {}));
  const parent = inheritedSource;
  const source = snapshot.source.entities[entity]?.value;
  const staged = draftState.entries.find(entry => entry.kind === "tags" && entry.entity === entity);
  const count = Object.keys({ ...Object.fromEntries(inherited), ...current }).length;
  const disabled = !!draftState.busy || live.evaluating || !!model.stale || draft.conflict || draftState.entries.some(entry => ["create", "resource", "environment"].includes(entry.kind));
  return <InspectorDisclosure title="Tags" className="declaration-tags" count={count} status={staged ? staged.error ? "invalid" : "modified" : undefined}>
    <p className="section-description">{route ? "Route tags follow the workload declaration. A route has no independently taggable AWS resource." : "Shared across development and production."}</p>
    {inherited.length ? <div className="inherited-tags"><span className="small muted">Inherited from {parent ? <button className="linkish" onClick={() => select(parent)}>{parent.replace(/^resource:/, "resources.")}</button> : "producer"}</span>{inherited.map(([key, value]) => <div className="inherited-tag" key={key}><code>{key}</code><span>{value || "(empty)"}</span><span className="small muted">{Object.hasOwn(current, key) ? "Overridden" : "Inherited"}</span></div>)}</div> : null}
    {editable || !editability ? <TagRows value={current} disabled={disabled || !editable} onChange={(tags, error) => draft.changeTags(entity, tags, error)} /> : <><dl className="tag-readonly">{Object.entries(facts.effective).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || "(empty)"}</dd></div>)}</dl><p className="small muted">{reason}</p></>}
    {!editability ? <RefreshTagEditor entity={entity} /> : null}
    {inherited.length ? <p className="small muted">Removing an override restores the inherited value. Add the same key to override an inherited value.</p> : null}
    <p className="small muted">{facts.aws.note}</p>
    {staged ? <p className="small muted">Unsaved · Review Changes to save.</p> : null}
    {source ? <a className="small" href={editorLink(snapshot.repositoryRoot, source)}>Open tag declaration in VS Code</a> : null}
  </InspectorDisclosure>;
}
