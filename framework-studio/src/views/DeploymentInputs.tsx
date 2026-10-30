import { EntityName } from "./EntityName";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ModelResource, SourceLocation } from "../../shared/model";
import { api } from "../api";
import { editorLink, titleOf } from "../lookup";
import { useStudio } from "../studio";
import { EntityIcon } from "./EntityIcon";
import { EnvironmentFileStatus } from "./ResourceStatus";
import type { DeploymentInputDetails, DeploymentInputEntry } from "../../shared/deployment-inputs";
import type { EnvironmentEdit } from "../draft";
import { Description } from "./Description";
import { InspectorDisclosure, InspectorKind } from "./InspectorUI";
import { EnvironmentValueControl as ValueControl } from "./EnvironmentValueControl";

const inputFlagClasses = (attention = false) => cx("flex-none rounded-full border px-[7px] py-px text-meta leading-[1.5]", attention ? "border-refuse bg-refuse-wash text-refuse" : "border-rule-strong text-graphite");

/** How a file's line reads, without the value: set, blank with a default standing in, or absent. */
export function lineSummary(entry: DeploymentInputEntry): string {
  if (entry.status === "configured") return "Set";
  if (entry.default !== undefined) return `Default · ${entry.default}`;
  return entry.status === "empty" ? "Blank" : "Not set";
}

export function InputSources({ resource }: { resource: ModelResource }) {
  const { select, snapshot } = useStudio();
  if (!resource.inputSources?.length) return null;
  return <InspectorDisclosure title="Environment file sources"><p className={"text-caption text-graphite"}>Names and presence only. Open a file inspector to edit its local values.</p>
    {resource.inputSources.map(({ file, entry }) => <p className={"text-caption"} key={file}>
      <button className={buttonClasses({ variant: "link" })} onClick={() => select(file.endsWith(".dev") ? "envfile:dev" : "envfile:prod")}>{file}</button> · {entry.notRead ? "Written but not read" : lineSummary(entry)}
      {entry.source ? <> · <a href={editorLink(snapshot.repositoryRoot, entry.source)}>Open assignment</a></> : null}
    </p>)}
  </InspectorDisclosure>;
}

const MODE_NAMES = { dev: "development", prod: "production" } as const;

/**
 * Both files list the same variables: each file's own lines, the other file's lines, and every
 * input this graph's catalog declares. A row without a line here is still editable, and writes a
 * line only once it is given a value.
 */
export function EnvironmentFileView({ resource }: { resource: ModelResource }) {
  const { snapshot, mode, select, index, draft, draftState, live } = useStudio();
  const file = resource.deploymentFile!;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState<DeploymentInputDetails>();
  const [filter, setFilter] = useState("");
  // Secret values the server withheld, fetched one at a time when someone reveals them.
  const [revealed, setRevealed] = useState<Readonly<Record<string, string>>>({});
  const pending = draft.environment(file.mode);
  const edits = pending?.edits ?? [];
  const descriptionPending = draftState.entries.some((entry) => entry.kind === "description");
  const disabled = !!draftState.busy || draft.conflict || live.evaluating || !details || descriptionPending;
  const other = file.mode === "dev" ? "prod" : "dev";
  useEffect(() => {
    if (draft.dirty) return;
    const controller = new AbortController();
    setDetails(undefined); setError(""); setRevealed({});
    if (file.exists) void api.inputDetails(file.mode, controller.signal).then((value) => { if (!controller.signal.aborted) setDetails(value); }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not read the inputs file."); });
    return () => controller.abort();
  }, [file.mode, file.exists, snapshot.revision, draft, draft.dirty]);
  const saved = new Map(details?.entries.map((entry) => [entry.name, entry]));
  const update = (next: readonly EnvironmentEdit[]) => { if (details) draft.setEnvironment(file.mode, pending?.hash ?? details.hash, next, details.entries.map((entry) => entry.name)); };
  const change = (key: string, fields: Partial<EnvironmentEdit>) => update(edits.map((edit) => edit.key === key ? { ...edit, ...fields } : edit));
  const add = () => { setFilter(""); update([...edits, { key: `new:${crypto.randomUUID()}`, name: "", value: "", create: true }]); };
  const valueOf = (name: string) => edits.find((edit) => edit.key === name)?.value ?? revealed[name] ?? saved.get(name)?.value ?? "";
  /** A withheld secret is set even though its value never reached the browser. */
  const hidden = (name: string) => !!saved.get(name)?.hidden && revealed[name] === undefined && !edits.some((edit) => edit.key === name);
  const reveal = (name: string) => async () => {
    if (!saved.get(name)?.hidden || revealed[name] !== undefined) return;
    const { value } = await api.revealInput(file.mode, name);
    setRevealed((current) => ({ ...current, [name]: value }));
  };
  // A row without a line writes one only once it holds a value; clearing it again drops the edit.
  // Clearing a withheld secret that was never revealed keeps it, rather than blanking it unseen.
  const setValue = (name: string, value: string) => {
    const line = saved.get(name);
    const others = edits.filter((edit) => edit.key !== name);
    const original = line?.hidden ? revealed[name] : line?.value;
    update(!line ? (value === "" ? others : [...others, { key: name, name, value, create: true }])
      : line.hidden && original === undefined && value === "" ? others
      : [...others, { key: name, name, value, ...(original === undefined ? {} : { original }) }]);
  };
  const location = (name: string): SourceLocation => ({ file: name, line: 1, column: 1, start: 0, end: 0 });
  const create = async () => {
    setBusy(true); setError("");
    try { await api.createDeploymentInput(file.mode); await client.invalidateQueries({ queryKey: ["snapshot"] }); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not generate the inputs file."); }
    finally { setBusy(false); }
  };
  // A line the snapshot has not caught up with yet is still listed.
  const entries: DeploymentInputEntry[] = [...file.entries, ...(details?.entries ?? []).filter((line) => !file.entries.some((entry) => entry.name === line.name))
    .map((line) => ({ name: line.name, status: line.value.trim() ? "configured" as const : "empty" as const, counterpart: "missing" as const, sensitive: line.sensitive, defaulted: false, targets: [] }))];
  const required = (entry: DeploymentInputEntry) => entry.requirements?.filter((item) => item.required) ?? [];
  const missing = (entry: DeploymentInputEntry) => required(entry).length > 0 && entry.default === undefined && !valueOf(entry.name).trim() && !hidden(entry.name);
  const unmet = entries.filter(missing);
  const matches = entries.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()));
  const groups = [
    { title: "Inputs and secrets", rows: matches.filter((entry) => entry.targets.length) },
    { title: "Deployment settings", rows: matches.filter((entry) => !entry.targets.length && entry.owner === "deployment") },
    { title: "Database", rows: matches.filter((entry) => !entry.targets.length && entry.owner === "database"),
      note: file.mode === "prod" ? "Production RDS overrides. Blank uses the database declaration." : "Production RDS overrides. Development builds no RDS, so this file's lines are not read." },
    { title: "Other variables", rows: matches.filter((entry) => !entry.targets.length && !entry.owner) },
  ].filter((group) => group.rows.length);
  const created = edits.filter((edit) => edit.key.startsWith("new:"));
  const row = (entry: DeploymentInputEntry) => {
    const value = valueOf(entry.name);
    const reasons = [...new Set(required(entry).flatMap((item) => item.reasons))];
    const onlyHere = entry.targets.length > 0 && entry.targets.every((id) => snapshot.models[file.mode].resources.find((item) => item.id === id)?.modes?.[other].present === false);
    const placeholder = hidden(entry.name) ? "Set · hidden" : entry.default !== undefined ? `Default · ${entry.default}` : !entry.targets.length && entry.status === "missing" ? `Only in .env.${other}` : entry.status === "empty" ? "Blank" : "Not set";
    const locked = entry.name === "PROD_DEPLOYMENT";
    return <li key={entry.name} className={missing(entry) ? "[&_input]:border-refuse [&_textarea]:border-refuse [&_select]:border-refuse" : undefined}>
      <div className={"flex flex-wrap items-center gap-2 min-w-0 [&>code]:flex-[1_1_auto] [&>code]:min-w-0 [&>code]:text-meta [&>code]:font-medium [&>code]:wrap-anywhere"} data-slot="input-entry-heading"><code>{entry.name}</code>
        {onlyHere && !entry.notRead ? <span className={inputFlagClasses()} data-slot="input-flag">{file.mode === "dev" ? "Development" : "Production"} only</span> : null}
        {entry.notRead ? <span className={inputFlagClasses(true)} data-slot="input-flag">Not read in {MODE_NAMES[file.mode]}</span> : null}
        {reasons.length ? <span className={inputFlagClasses(missing(entry))} title={reasons.join(" ")} data-slot="input-flag">Required</span> : null}
      </div>
      {entry.choices && !entry.sensitive ? <Select aria-label={`Value for ${entry.name}`} value={value} disabled={disabled} onChange={(event) => setValue(entry.name, event.target.value)}>
        <option value="">{placeholder}</option>
        {value && !entry.choices.includes(value) ? <option value={value}>{value} (current)</option> : null}
        {entry.choices.map((choice) => <option key={choice}>{choice}</option>)}
      </Select> : <ValueControl name={entry.name} value={value} placeholder={placeholder} sensitive={entry.sensitive} disabled={disabled || locked} onChange={(value) => setValue(entry.name, value)} onReveal={reveal(entry.name)} />}
      {entry.targets.length || entry.note || locked || missing(entry) ? <p className={"flex flex-wrap gap-[var(--space-1)_var(--space-3)] m-0 text-caption text-graphite"} data-slot="input-entry-meta">
        {entry.targets.map((id) => <button key={id} className={cx(buttonClasses({ variant: "link" }), "text-caption")} onClick={() => select(id)}>{titleOf(index, id)}</button>)}
        {!entry.targets.length && entry.note ? <span>{entry.note}</span> : null}
        {locked ? <span>Determined by this file's environment.</span> : null}
        {missing(entry) ? <span className={"text-refuse wrap-anywhere"}>{reasons.join(" ")}</span> : null}
      </p> : null}
    </li>;
  };
  return <>
    <header><InspectorKind environments={{ availability: { dev: file.mode === "dev", prod: file.mode === "prod" }, descriptions: { [file.mode]: `inputs for ${MODE_NAMES[file.mode]}` }, unavailableDescription: "not this file's environment" }}>Environment file</InspectorKind><EntityName entity={resource.id} fallback={file.path} icon={<EntityIcon icon="envFile" />} /><EnvironmentFileStatus resource={resource} /></header>
    <Description entity={resource.id} />
    {descriptionPending ? <p className={"text-caption text-graphite"}>Apply or discard the description before editing environment variables.</p> : null}
    <InspectorDisclosure title="File and template" defaultOpen={!file.exists}><p>{file.exists ? "Local inputs file exists." : "This inputs file has not been generated."} {file.mode === mode ? "Used for synthesis in the selected graph." : "Switch the graph to use this environment for synthesis."}</p>
      {file.exists ? <p><a href={editorLink(snapshot.repositoryRoot, location(file.path))}>Open file in editor</a></p> : <button className={buttonClasses({ variant: "neutral" })} disabled={busy || draft.dirty} onClick={() => void create()}>{busy ? "Generating…" : `Generate .env.${file.mode} from template`}</button>}
      <p className={"text-caption"}><a href={editorLink(snapshot.repositoryRoot, location(file.template))}>Template: {file.template}</a></p>
      <p className={"text-caption text-graphite"}>Both files list the same variables. A variable without a line here writes one only when you give it a value; blank catalog inputs use their declared default. Review and apply to save. Values stay outside the graph, and production is never filled from development.</p>
      {file.problem || error ? <p role="alert">{file.problem || error}</p> : null}
    </InspectorDisclosure>
    {file.exists ? <section className={"[&>[data-slot=resource-control]]:mt-3"} data-slot="environment-editor"><h3>Environment variables ({entries.length + created.length})</h3>
      {unmet.length ? <p className={"text-caption text-refuse wrap-anywhere"} role="status">{unmet.length === 1 ? "A required value is" : `${unmet.length} required values are`} missing: {unmet.map((entry, at) => <span key={entry.name}>{at ? ", " : ""}<button className={cx(buttonClasses({ variant: "link" }), "text-caption")} onClick={() => setFilter(entry.name)}>{entry.name}</button></span>)}</p> : null}
      <div className={"flex items-center gap-2 m-[var(--space-3)_0] [&_input]:flex-1 [&_input]:w-full [&_button]:flex-none inspector-420:flex-wrap"} data-slot="environment-toolbar">
      <label className={"flex-1 min-w-0 inspector-420:basis-full"} data-slot="environment-search"><span className={"sr-only"}>Filter environment variables</span><TextInput type="search" aria-label="Filter environment variables" placeholder="Find a variable…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <button className={buttonClasses({ variant: "quiet" })} aria-label="Add environment variable" disabled={disabled} onClick={add}>Add variable</button></div>
      {!details && !error ? <p role="status" className={"text-caption text-graphite"}>Reading this local environment file…</p> : null}
      {pending?.error ? <p role="alert" className={"text-refuse wrap-anywhere"}>{pending.error}</p> : null}
      {created.length ? <ul className={"m-0 list-none p-0 [&>li]:grid [&>li]:gap-2 [&>li]:border-b [&>li]:border-rule [&>li]:py-3.5 [&>li>code]:text-meta [&>li>code]:font-medium [&_code]:wrap-anywhere [&>li>span:last-child]:flex [&>li>span:last-child]:flex-wrap [&>li>span:last-child]:gap-2.5"} data-slot="input-file-entries">{created.map((edit, at) => <li key={edit.key}>
        <label className={"my-3 grid min-w-0 gap-2 text-label font-medium wrap-anywhere [&>input]:w-full [&>select]:w-full"} data-slot="resource-control"><span>New variable name</span><TextInput autoFocus={at === created.length - 1} aria-label={`New variable name ${at + 1}`} disabled={disabled} autoComplete="off" spellCheck={false} value={edit.name} placeholder="VARIABLE_NAME" onChange={(event) => change(edit.key, { name: event.target.value })} /></label>
        <ValueControl name={edit.name || `new variable ${at + 1}`} value={edit.value} sensitive={true} disabled={disabled} onChange={(value) => change(edit.key, { value })} />
        <button className={cx(buttonClasses({ variant: "link" }), "text-caption")} disabled={!!draftState.busy} onClick={() => update(edits.filter((item) => item.key !== edit.key))}>Remove new variable</button>
      </li>)}</ul> : null}
      {groups.map((group) => <div key={group.title}>{groups.length > 1 ? <h4 className={"m-[var(--space-4)_0_0] text-caption font-medium text-graphite"} data-slot="input-group-heading">{group.title}</h4> : null}{"note" in group && group.note ? <p className={"text-caption text-graphite"}>{group.note}</p> : null}<ul className={"m-0 list-none p-0 [&>li]:grid [&>li]:gap-2 [&>li]:border-b [&>li]:border-rule [&>li]:py-3.5 [&>li>code]:text-meta [&>li>code]:font-medium [&_code]:wrap-anywhere [&>li>span:last-child]:flex [&>li>span:last-child]:flex-wrap [&>li>span:last-child]:gap-2.5"} data-slot="input-file-entries">{group.rows.map(row)}</ul></div>)}
      {filter && !matches.length ? <p className={"text-caption text-graphite"}>No variables match this search.</p> : null}
    </section> : null}
  </>;
}
