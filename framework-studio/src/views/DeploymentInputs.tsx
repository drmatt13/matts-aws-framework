import {
  inspectorSectionClasses,
  inspectorHeaderClasses,
  inspectorNoteClasses,
} from "../inspector-ui";

import { EntityName } from "./EntityName";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";

import { Fragment, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { Mode, ModelResource, SourceLocation } from "../../shared/model";
import { api } from "../api";
import { editorLink, titleOf } from "../lookup";
import { useStudio } from "../studio";
import { EntityIcon } from "./EntityIcon";
import { EnvironmentFileStatus } from "./ResourceStatus";
import { IssueNotice } from "./IssueNotice";
import { resourceIssues } from "../issues";
import {
  CDK_ENVIRONMENT_ID,
  FRAMEWORK_INPUT_GROUPS,
  isUndeclaredEnvironmentInput,
  type DeploymentInputDetails,
  type DeploymentInputEntry,
  type DeploymentInputFile,
} from "../../shared/deployment-inputs";
import type { EnvironmentEdit } from "../draft";
import { Description } from "./Description";
import { InspectorCount, InspectorDisclosure, InspectorKind, InspectorSummary } from "./InspectorUI";
import { EnvironmentValueControl as ValueControl } from "./EnvironmentValueControl";
import { EnvironmentPills } from "./DeploymentBadge";
import { RetryNotice } from "./RetryNotice";
import { openEnvironmentVariable, takeEnvironmentVariableRequest } from "../environment-variable-link";
import { inputGroupOf } from "../input-groups";
import { EnvironmentInputDeclaration } from "./EnvironmentInputDeclaration";

/** How a file's line reads, without the value: set, blank with a default standing in, or absent. */
export function lineSummary(entry: DeploymentInputEntry): string {
  if (entry.status === "configured") return "Set";
  if (entry.default !== undefined) return `Default · ${entry.default}`;
  return entry.status === "empty" ? "Blank" : "Not set";
}

export function InputSources({ resource }: { resource: ModelResource }) {
  const { select, snapshot } = useStudio();
  if (!resource.inputSources?.length) return null;
  return (
    <InspectorDisclosure title="Environment file sources">
      <p className="mt-0 mb-2 text-caption text-graphite">
        Names and presence only. Open a file to edit its local values in CDK environment.
      </p>
      {resource.inputSources.map(({ file, entry }) => (
        <p className="mt-0 mb-2 text-caption" key={file}>
          <button
            className={buttonClasses({ variant: "link" })}
            onClick={() => openEnvironmentVariable(select, file.endsWith(".dev") ? "dev" : "prod", entry.name)}
          >
            {file}
          </button>{" "}
          · {entry.notRead ? "Written but not read" : lineSummary(entry)}
          {entry.source ? (
            <>
              {" "}
              · <a href={editorLink(snapshot.repositoryRoot, entry.source)}>Open assignment</a>
            </>
          ) : null}
        </p>
      ))}
    </InspectorDisclosure>
  );
}

const MODES = ["dev", "prod"] as const;
const MODE_LABELS = { dev: "Dev", prod: "Prod" } as const;
const MODE_NAMES = { dev: "development", prod: "production" } as const;
const ENVIRONMENT_NAMES = { dev: "Development", prod: "Production" } as const;
const byMode = <T,>(make: (mode: Mode) => T): Record<Mode, T> => ({ dev: make("dev"), prod: make("prod") });

/** An environment's name in its own color, beside a value or a status. */
function EnvironmentLabel({ mode, className }: { readonly mode: Mode; readonly className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-[5px] text-meta font-semibold leading-[1.5] before:size-1.5 before:flex-none before:rounded-full before:bg-current before:content-['']",
        mode === "dev" ? "text-dev" : "text-prod",
        className,
      )}
      data-environment={mode}
    >
      {MODE_LABELS[mode]}
    </span>
  );
}

/** One variable across both files: each file's entry comes from its own environment's graph. */
interface VariableRow {
  readonly name: string;
  readonly entries: Readonly<Partial<Record<Mode, DeploymentInputEntry>>>;
}
/** Whether this environment reads the variable at all: its catalog targets, or its framework reader. */
const reads = (entry: DeploymentInputEntry | undefined, mode: Mode): boolean =>
  !!entry && !entry.notRead && (!entry.owner || FRAMEWORK_INPUT_GROUPS[entry.owner].modes.includes(mode));
const required = (entry: DeploymentInputEntry | undefined) =>
  !!entry?.requirements?.some((item) => item.required);
const location = (file: string): SourceLocation => ({ file, line: 1, column: 1, start: 0, end: 0 });

/**
 * CDK environment: both private input files as one list. Each variable shows a Dev | Prod pair —
 * lit where that environment has a value, red where a required one is missing — and opens to edit
 * both values side by side. One review writes whichever files changed; values never enter the graph.
 */
export function EnvironmentFileView({ resource }: { resource: ModelResource }) {
  const { snapshot, select, index, draft, draftState, live } = useStudio();
  const client = useQueryClient();
  const collection = resource.deploymentFiles ? resource : index.resources.get(CDK_ENVIRONMENT_ID);
  const ids = collection?.deploymentFiles ?? { dev: "envfile:dev", prod: "envfile:prod" };
  // Each physical file as its own environment's graph sees it; a selected file is its own.
  const fileResources = byMode((mode) => resource.deploymentFile?.mode === mode ? resource
    : snapshot.models[mode].resources.find((item) => item.id === ids[mode]));
  const files: Record<Mode, DeploymentInputFile | undefined> = byMode((mode) => fileResources[mode]?.deploymentFile);
  const pathOf = (mode: Mode) => files[mode]?.path ?? `cdk-app/.env.${mode}`;

  const [details, setDetails] = useState<Partial<Record<Mode, DeploymentInputDetails>>>({});
  const [readErrors, setReadErrors] = useState<Partial<Record<Mode, string>>>({});
  const [readAttempt, setReadAttempt] = useState(0);
  // Secret values the server withheld, fetched one at a time when someone reveals them.
  const [revealed, setRevealed] = useState<Readonly<Record<Mode, Readonly<Record<string, string>>>>>({ dev: {}, prod: {} });
  const [filter, setFilter] = useState("");
  // Names captured when the filter was chosen, so a row stays put while its value is typed.
  const [missingIn, setMissingIn] = useState<{ readonly mode: Mode; readonly names: ReadonlySet<string> }>();
  const [focus, setFocus] = useState(takeEnvironmentVariableRequest);
  const [creating, setCreating] = useState<Mode>();
  const [createError, setCreateError] = useState("");
  const requests = useRef(new AbortController());
  const rowElements = useRef(new Map<string, HTMLDetailsElement>());
  const removalBackups = useRef(new Map<string, Partial<Record<Mode, EnvironmentEdit>>>());

  const exists = { dev: !!files.dev?.exists, prod: !!files.prod?.exists };
  // A dirty draft pins its baseline; newer source still retires private reveals.
  useEffect(() => {
    requests.current = new AbortController();
    setRevealed({ dev: {}, prod: {} });
    return () => requests.current.abort();
  }, [draftState.latest.revision]);
  useEffect(() => {
    if (draft.dirty) return;
    const controller = new AbortController();
    setDetails({});
    setReadErrors({});
    setRevealed({ dev: {}, prod: {} });
    for (const mode of MODES)
      if (exists[mode])
        void api
          .inputDetails(mode, controller.signal)
          .then((value) => {
            if (!controller.signal.aborted) setDetails((current) => ({ ...current, [mode]: value }));
          })
          .catch((reason: unknown) => {
            if (!controller.signal.aborted)
              setReadErrors((current) => ({ ...current, [mode]: reason instanceof Error ? reason.message : "Could not read this environment file." }));
          });
    return () => controller.abort();
  }, [exists.dev, exists.prod, snapshot.revision, draft, draft.dirty, readAttempt]);

  const lines = byMode((mode) => new Map(details[mode]?.entries.map((line) => [line.name, line])));
  const pending = { dev: draft.environment("dev"), prod: draft.environment("prod") };
  const editsOf = (mode: Mode) => pending[mode]?.edits ?? [];
  const editOf = (mode: Mode, name: string) => editsOf(mode).find((edit) => edit.key === name);
  const descriptionPending = draftState.entries.some((entry) => entry.kind === "description");
  const declarationPending = !!draft.creation();
  const locked = !!draftState.busy || draft.conflict || live.evaluating || descriptionPending || declarationPending;
  const disabledFor = (mode: Mode) => locked || !details[mode];

  const update = (mode: Mode, next: readonly EnvironmentEdit[]) => {
    const file = details[mode];
    if (file) draft.setEnvironment(mode, pending[mode]?.hash ?? file.hash, next, file.entries.map((entry) => entry.name));
  };
  const valueOf = (mode: Mode, name: string) =>
    editOf(mode, name)?.value ?? revealed[mode][name] ?? lines[mode].get(name)?.value ?? "";
  /** A withheld secret is set even though its value never reached the browser. */
  const hidden = (mode: Mode, name: string) =>
    !!lines[mode].get(name)?.hidden && revealed[mode][name] === undefined && !editOf(mode, name);
  const reveal = (mode: Mode, name: string) => async () => {
    if (!lines[mode].get(name)?.hidden || revealed[mode][name] !== undefined) return;
    const signal = requests.current.signal;
    const { value } = await api.revealInput(mode, name, signal);
    signal.throwIfAborted();
    setRevealed((current) => ({ ...current, [mode]: { ...current[mode], [name]: value } }));
  };
  // A row without a line writes one only once it holds a value; clearing it again drops the edit.
  // Clearing a withheld secret that was never revealed keeps it, rather than blanking it unseen.
  const setValue = (mode: Mode, name: string, value: string) => {
    const line = lines[mode].get(name);
    const others = editsOf(mode).filter((edit) => edit.key !== name);
    const original = line?.hidden ? revealed[mode][name] : line?.value;
    update(mode,
      !line
        ? value === "" ? others : [...others, { key: name, name, value, create: true }]
        : line.hidden && original === undefined && value === ""
          ? others
          : [...others, { key: name, name, value, ...(original === undefined ? {} : { original }) }],
    );
  };

  // Every name either file lists, plus a line the snapshot has not caught up with yet.
  const byName = new Map<string, Partial<Record<Mode, DeploymentInputEntry>>>();
  for (const mode of MODES) {
    for (const entry of files[mode]?.entries ?? []) byName.set(entry.name, { ...byName.get(entry.name), [mode]: entry });
    for (const line of details[mode]?.entries ?? [])
      if (!byName.get(line.name)?.[mode])
        byName.set(line.name, { ...byName.get(line.name), [mode]: { name: line.name,
          status: line.hidden || line.value.trim() ? "configured" : "empty", counterpart: "missing",
          sensitive: line.sensitive, defaulted: false, targets: [] } });
  }
  const rows: VariableRow[] = [...byName]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entries]) => ({ name, entries }));
  // Use both input models: a group can exist only in the other environment. The selected
  // model wins shared identities, just as its labels do elsewhere in the inspector.
  const declarations = new Map([...MODES.flatMap((mode) => snapshot.models[mode].resources), ...index.resources.values()].map((item) => [item.id, item]));
  const inputIndex = { ...index, resources: declarations };
  const groupedRows = rows.map((row) => ({ ...row, group: MODES.flatMap((mode) => row.entries[mode]?.targets ?? [])
    .map((id) => declarations.get(id)).filter((item) => !!item)
    .map((item) => inputGroupOf(item, declarations)).find((group) => !!group) }));

  const hasValue = (row: VariableRow, mode: Mode) => {
    const edit = editOf(mode, row.name);
    if (edit) return !!edit.value.trim();
    const line = lines[mode].get(row.name);
    if (details[mode]) return !!line && (!!line.hidden || !!line.value.trim());
    return row.entries[mode]?.status === "configured";
  };
  const missing = (row: VariableRow, mode: Mode) => {
    const entry = row.entries[mode];
    return exists[mode] && reads(entry, mode) && required(entry) && entry?.default === undefined && !hasValue(row, mode);
  };
  const missingRows = byMode((mode) => rows.filter((row) => missing(row, mode)));
  const removed = (name: string) => MODES.some(mode => !!editOf(mode, name)?.remove);
  const toggleRemoval = (name: string) => {
    const undo = removed(name);
    if (!undo) removalBackups.current.set(name, Object.fromEntries(MODES.flatMap(mode => editOf(mode, name) ? [[mode, editOf(mode, name)!]] : [])));
    for (const mode of MODES) {
      if (!lines[mode].has(name)) continue;
      const others = editsOf(mode).filter(edit => edit.key !== name);
      const previous = removalBackups.current.get(name)?.[mode];
      update(mode, undo ? previous ? [...others, previous] : others : [...others, { key: name, name, value: "", remove: true }]);
    }
    if (undo) removalBackups.current.delete(name);
  };

  // New variables join both files under one key; a blank value writes an empty line.
  const writable = MODES.filter((mode) => !!details[mode]);
  const created = [...MODES.flatMap((mode) => editsOf(mode).filter((edit) => edit.key.startsWith("new:")).map((edit) => ({ mode, edit })))
    .reduce((items, { mode, edit }) => items.set(edit.key, { key: edit.key, name: edit.name, values: { ...items.get(edit.key)?.values, [mode]: edit.value } }),
      new Map<string, { readonly key: string; readonly name: string; readonly values: Partial<Record<Mode, string>> }>()).values()];
  const add = () => {
    setFilter("");
    setMissingIn(undefined);
    const key = `new:${crypto.randomUUID()}`;
    for (const mode of writable) update(mode, [...editsOf(mode), { key, name: "", value: "", create: true }]);
  };
  const changeCreated = (key: string, fields: Partial<EnvironmentEdit>, only?: Mode) => {
    for (const mode of only ? [only] : MODES)
      if (editsOf(mode).some((edit) => edit.key === key))
        update(mode, editsOf(mode).map((edit) => (edit.key === key ? { ...edit, ...fields } : edit)));
  };
  const removeCreated = (key: string) => {
    for (const mode of MODES)
      if (editsOf(mode).some((edit) => edit.key === key)) update(mode, editsOf(mode).filter((edit) => edit.key !== key));
  };

  const create = async (mode: Mode) => {
    setCreating(mode);
    setCreateError("");
    try {
      await api.createDeploymentInput(mode);
      await client.invalidateQueries({ queryKey: ["snapshot"] });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : `Could not create ${pathOf(mode)}.`);
    } finally {
      setCreating(undefined);
    }
  };

  // A link from another inspector opens its variable and focuses that environment's value once it is editable.
  useEffect(() => {
    if (!focus) return;
    const row = rowElements.current.get(focus.name);
    if (!row || !exists[focus.mode]) { setFocus(undefined); return; }
    row.open = true;
    row.scrollIntoView?.({ block: "nearest" });
    const value = `[data-slot="environment-value"][data-environment="${focus.mode}"]`;
    const control = row.querySelector<HTMLElement>(["input", "textarea", "select"].map((tag) => `${value} ${tag}:not(:disabled)`).join(", "));
    if (control) { control.focus(); setFocus(undefined); }
  });
  useEffect(() => {
    if (missingIn) for (const name of missingIn.names) { const row = rowElements.current.get(name); if (row) row.open = true; }
  }, [missingIn]);

  const query = filter.trim().toLowerCase();
  const matches = groupedRows.filter((row) => (!query || row.name.toLowerCase().includes(query)) && (!missingIn || missingIn.names.has(row.name)));
  const groups = [...new Map(matches.flatMap((row) => row.group ? [[row.group.id, row.group] as const] : [])).values()]
    .map((group) => ({ key: group.id, title: titleOf(inputIndex, group.id), note: draft.description(group.id).trim(), rows: matches.filter((row) => row.group?.id === group.id) }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const ungrouped = matches.filter((row) => !row.group);
  const errors = [...new Set(MODES.flatMap((mode) => pending[mode]?.error ? [pending[mode]!.error!] : []))];
  // This inspector always covers both files, including a legacy file link in the other source mode.
  const issues = resourceIssues({ ...(collection ?? resource), deploymentFiles: ids }, Object.values(fileResources).filter(item => !!item).map(item => ({ ...item, absent: false })))
    .filter(issue => !issue.variable || !removed(issue.variable));
  const unavailableFiles = MODES.filter((mode) => files[mode] && !files[mode]!.exists);

  const valueLine = (row: VariableRow, mode: Mode) => {
    const entry = row.entries[mode];
    const label = `${row.name} in ${ENVIRONMENT_NAMES[mode]}`;
    const note = (text: string, tone: "muted" | "refuse" = "muted") => (
      <p className={cx("m-0 flex min-h-(--panel-control-height) items-center text-caption", tone === "refuse" ? "text-refuse" : "text-graphite")}>{text}</p>
    );
    let content;
    if (!exists[mode]) content = note(`${pathOf(mode)} is missing.`);
    else if (!entry || (!reads(entry, mode) && entry.status === "missing")) content = note(`Not read in ${MODE_NAMES[mode]}.`);
    else {
      const value = valueOf(mode, row.name);
      const undeclared = isUndeclaredEnvironmentInput(entry);
      const invalid = missing(row, mode);
      const errorId = `undeclared-${row.name}`;
      const fixed = row.name === "PROD_DEPLOYMENT";
      const placeholder = hidden(mode, row.name)
        ? "Set · hidden"
        : entry.default !== undefined
          ? `Default · ${entry.default}`
          : required(entry) ? "Required" : entry.status === "empty" ? "Blank" : "Not set";
      const reasons = [...new Set(entry.requirements?.filter((item) => item.required).flatMap((item) => item.reasons) ?? [])];
      content = (
        <>
          {entry.choices && !entry.sensitive ? (
            <Select
              aria-invalid={invalid}
              aria-describedby={undeclared ? errorId : undefined}
              aria-label={`Value for ${label}`}
              value={value}
              disabled={disabledFor(mode) || removed(row.name)}
              onChange={(event) => setValue(mode, row.name, event.target.value)}
            >
              <option value="">{placeholder}</option>
              {value && !entry.choices.includes(value) ? <option value={value}>{value} (current)</option> : null}
              {entry.choices.map((choice) => <option key={choice}>{choice}</option>)}
            </Select>
          ) : (
            <ValueControl
              key={`${details[mode]?.hash ?? "loading"}:${draftState.latest.revision}`}
              invalid={invalid}
              describedBy={undeclared ? errorId : undefined}
              name={label}
              value={value}
              placeholder={placeholder}
              sensitive={entry.sensitive}
              disabled={disabledFor(mode) || fixed || removed(row.name)}
              onChange={(next) => setValue(mode, row.name, next)}
              onReveal={reveal(mode, row.name)}
            />
          )}
          {entry.notRead ? <p className="m-0 text-caption text-refuse">Written here, but {MODE_NAMES[mode]} never reads it.</p> : null}
          {invalid && reasons.length ? <p className="m-0 text-caption text-refuse wrap-anywhere">{reasons.join(" ")}</p> : null}
          {fixed ? <p className="m-0 text-caption text-graphite">Set by each file's environment.</p> : null}
        </>
      );
    }
    return (
      <div key={mode} className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-x-2" data-slot="environment-value" data-environment={mode}>
        <EnvironmentLabel mode={mode} className="min-h-(--panel-control-height)" />
        <div className="grid min-w-0 gap-1">{content}</div>
      </div>
    );
  };

  const variable = (row: VariableRow) => {
    const undeclared = (mode: Mode) => !!row.entries[mode] && isUndeclaredEnvironmentInput(row.entries[mode]!);
    const attention = byMode((mode) => missing(row, mode) || undeclared(mode));
    const lit = (mode: Mode) => !undeclared(mode) && reads(row.entries[mode], mode) && (hasValue(row, mode) || row.entries[mode]?.default !== undefined);
    const edited = MODES.some((mode) => !!editOf(mode, row.name));
    const absent = !removed(row.name) && (attention.dev || attention.prod);
    const targets = [...new Set(MODES.flatMap((mode) => row.entries[mode]?.targets ?? []))];
    const note = MODES.map((mode) => row.entries[mode]?.note).find(Boolean);
    return (
      <li key={row.name} className="border-t border-rule first:border-t-0">
        <details
          ref={(element) => { if (element) rowElements.current.set(row.name, element); else rowElements.current.delete(row.name); }}
          data-slot="environment-variable"
          data-variable={row.name}
        >
          <InspectorSummary className="flex min-w-0 cursor-pointer items-center gap-2 py-2.5 text-caption">
            <span className={cx("flex min-w-0 flex-1 items-center gap-1.5", absent && "text-refuse")} data-slot="environment-variable-name">
              {absent ? <X size={14} aria-hidden className="flex-none" /> : null}
              <code className="min-w-0 text-meta font-medium wrap-anywhere">{row.name}</code>
              {absent ? <span className="sr-only">{MODES.some(undeclared) ? ", undeclared variable" : ", required value missing"}</span> : null}
            </span>
            {edited ? <span className="flex-none text-meta text-graphite" data-slot="environment-variable-edited">Edited</span> : null}
            <EnvironmentPills
              className="flex-none"
              label={`${row.name} environments`}
              availability={{ dev: lit("dev"), prod: lit("prod") }}
              attention={attention}
              descriptions={byMode((mode) => hasValue(row, mode) ? "set" : `uses the default ${row.entries[mode]?.default}`)}
              unavailableDescription={byMode((mode) =>
                undeclared(mode) ? "undeclared variable" : attention[mode] ? "required value missing" : reads(row.entries[mode], mode) ? "blank" : `not read in ${MODE_NAMES[mode]}`)}
            />
          </InspectorSummary>
          {/* Indented past the disclosure chevron, so each environment's label sits under the name. */}
          <div className="grid gap-2 pb-3.5 pl-[17px]" data-slot="environment-variable-values">
            {MODES.some(undeclared) ? (
              <div className="grid min-w-0 gap-2" data-slot="environment-variable-resolution">
                <p id={`undeclared-${row.name}`} className={cx("m-0 text-caption wrap-anywhere", removed(row.name) ? "text-graphite" : "text-refuse")}>
                  {removed(row.name) ? "Removal staged from every file containing this variable." : "This variable has no input parameter or secret. Create a declaration or remove it from the environment files."}
                </p>
                {draft.creation()?.environmentVariable === row.name ? <EnvironmentInputDeclaration name={row.name} resources={declarations} cancel={() => {
                  draft.discard();
                  requestAnimationFrame(() => rowElements.current.get(row.name)?.querySelector<HTMLElement>('[data-slot="create-environment-input"]')?.focus());
                }} /> : (
                  <div className="flex flex-wrap gap-3">
                    {!removed(row.name) ? <button data-slot="create-environment-input" className={buttonClasses({ variant: "link" })} disabled={locked || draft.dirty}
                      onClick={() => draft.beginEnvironmentInput(row.name, Object.values(row.entries).some(entry => entry.sensitive))}>Create input parameter or secret</button> : null}
                    <button className={buttonClasses({ variant: "link" })}
                      disabled={locked || MODES.some(mode => !!row.entries[mode] && row.entries[mode]!.status !== "missing" && !details[mode])}
                      onClick={() => toggleRemoval(row.name)}>{removed(row.name) ? "Undo removal" : "Remove variable"}</button>
                  </div>
                )}
                {draft.dirty && !declarationPending && !removed(row.name) ? <p className="m-0 text-caption text-graphite">Apply or discard value changes before creating a declaration.</p> : null}
              </div>
            ) : null}
            {MODES.map((mode) => valueLine(row, mode))}
            {targets.length || note ? (
              <p className="m-0 flex flex-wrap gap-[var(--space-1)_var(--space-3)] text-caption text-graphite" data-slot="input-entry-meta">
                {targets.map((id) => (
                  <button key={id} className={cx(buttonClasses({ variant: "link" }), "text-caption")} onClick={() => select(id)}>
                    {titleOf(index, id)}
                  </button>
                ))}
                {note ? <span>{note}</span> : null}
              </p>
            ) : null}
          </div>
        </details>
      </li>
    );
  };

  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind environments={{ availability: { dev: true, prod: true }, descriptions: { dev: pathOf("dev"), prod: pathOf("prod") } }}>
          Environment files
        </InspectorKind>
        <EntityName entity={CDK_ENVIRONMENT_ID} fallback="CDK environment" icon={<EntityIcon size={24} icon="envFile" />} />
        <EnvironmentFileStatus resource={collection ?? resource} />
        {/* Where each environment's values live, as the client mappings' header names its exports. */}
        <dl
          aria-label="Environment input files"
          data-ui="written"
          data-slot="cdk-environment-files"
          className="mt-2 mb-0 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-meta text-graphite"
        >
          {MODES.map((mode) => (
            <Fragment key={mode}>
              <dt>{MODE_LABELS[mode]} file</dt>
              <dd className="m-0 flex min-h-5.5 min-w-0 items-center">
                {exists[mode] ? (
                  <a className="min-w-0 wrap-anywhere" href={editorLink(snapshot.repositoryRoot, location(pathOf(mode)))} title="Open in editor">
                    <code className="text-meta">{pathOf(mode)}</code>
                  </a>
                ) : (
                  <code className="min-w-0 text-meta wrap-anywhere">{pathOf(mode)}</code>
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
        <IssueNotice issues={issues} />
        {unavailableFiles.length ? (
          <div className="mt-3 flex flex-wrap gap-2" data-slot="environment-file-setup">
            {unavailableFiles.map((mode) => (
              <button
                key={mode}
                className={buttonClasses({ variant: "neutral" })}
                disabled={!!creating || draft.dirty}
                onClick={() => void create(mode)}
              >
                {creating === mode ? "Creating…" : `Create .env.${mode} from template`}
              </button>
            ))}
            {createError ? <p className="m-0 basis-full text-caption text-refuse wrap-anywhere" role="alert">{createError}</p> : null}
          </div>
        ) : null}
      </header>
      <Description entity={CDK_ENVIRONMENT_ID} />
      <section className={inspectorSectionClasses} data-slot="environment-editor" aria-label="Variables">
        <h3 className="mt-0 mb-3 flex items-center gap-2 text-label font-semibold text-balance">
          Variables
          <InspectorCount>{rows.length + created.length}</InspectorCount>
        </h3>
        {/* Readiness first: what each environment still needs before synthesis can use it. */}
        <ul className="m-0 grid list-none gap-1 p-0" data-slot="environment-readiness" aria-label="Required values">
          {MODES.map((mode) => {
            const count = missingRows[mode].length;
            const showing = missingIn?.mode === mode;
            const status = !files[mode]
              ? "File information unavailable"
              : !exists[mode]
                ? "File missing"
                : files[mode]!.problem || readErrors[mode]
                  ? "Could not be read"
                  : count
                    ? `${count === 1 ? "1 required value" : `${count} required values`} missing`
                    : "Every required value is set";
            const problem = !exists[mode] || !!files[mode]?.problem || !!readErrors[mode] || count > 0;
            return (
              <li key={mode} className="flex min-h-(--panel-caption-target) items-center gap-2 text-caption" data-environment={mode} data-slot="environment-readiness-row">
                <EnvironmentLabel mode={mode} className="w-[2.75rem] flex-none" />
                <span className={cx("min-w-0 flex-1 wrap-anywhere", problem ? "text-refuse" : "text-graphite")}>{status}</span>
                {count || showing ? (
                  <button
                    className={cx(buttonClasses({ variant: "link" }), "flex-none text-caption")}
                    aria-pressed={showing}
                    aria-label={showing ? "Show all variables" : `Show what ${ENVIRONMENT_NAMES[mode]} still needs`}
                    onClick={() => {
                      setFilter("");
                      setMissingIn(showing ? undefined : { mode, names: new Set(missingRows[mode].map((row) => row.name)) });
                    }}
                  >
                    {showing ? "Show all" : "Show"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="my-3 flex items-center gap-2 inspector-420:flex-wrap" data-slot="environment-toolbar">
          <label className="min-w-0 flex-1 inspector-420:basis-full" data-slot="environment-search">
            <span className="sr-only">Filter environment variables</span>
            <TextInput
              className="w-full flex-1"
              type="search"
              aria-label="Filter environment variables"
              placeholder="Find a variable…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <button
            className={buttonClasses({ variant: "quiet", className: "flex-none" })}
            aria-label="Add environment variable"
            disabled={locked || !writable.length}
            onClick={add}
          >
            Add variable
          </button>
        </div>
        {/* Transient notices share one container, so the rows' structural positions (which restore
            open rows on Back) never shift while values load. */}
        <div data-slot="environment-notices">
          {descriptionPending ? (
            <p className="mt-0 mb-2 text-caption text-graphite">
              Apply or discard the description before editing environment variables.
            </p>
          ) : null}
          {missingIn ? (
            <p className="mt-0 mb-2 text-caption text-graphite" role="status">
              Showing only what {ENVIRONMENT_NAMES[missingIn.mode]} still needs.
            </p>
          ) : null}
          {MODES.map((mode) =>
            readErrors[mode] ? (
              <RetryNotice
                key={mode}
                message={`${pathOf(mode)}: ${readErrors[mode]}`}
                retryLabel="Retry reading"
                retrying={false}
                onRetry={() => setReadAttempt((value) => value + 1)}
              />
            ) : null,
          )}
          {MODES.some((mode) => exists[mode] && !details[mode] && !readErrors[mode]) ? (
            <p role="status" className="mt-0 mb-2 text-caption text-graphite">Reading local values…</p>
          ) : null}
          {errors.map((error) => (
            <p key={error} role="alert" className="mt-0 mb-2 text-refuse wrap-anywhere">{error}</p>
          ))}
        </div>
        <ul className="m-0 list-none p-0" data-slot="new-environment-variables">
          {created.map((item, at) => {
            const label = item.name || `new variable ${at + 1}`;
            const listed = !!item.name && byName.has(item.name);
            return (
              <li className="grid gap-2 border-b border-rule py-3.5" key={item.key} data-slot="new-environment-variable">
                <label className="grid min-w-0 gap-1 text-label font-medium wrap-anywhere" data-slot="resource-control">
                  <span>New variable name</span>
                  <TextInput
                    className="w-full"
                    autoFocus={at === created.length - 1}
                    aria-label={`New variable name ${at + 1}`}
                    aria-invalid={listed}
                    disabled={locked}
                    autoComplete="off"
                    spellCheck={false}
                    value={item.name}
                    placeholder="VARIABLE_NAME"
                    onChange={(event) => changeCreated(item.key, { name: event.target.value })}
                  />
                </label>
                {listed ? <p className="m-0 text-caption text-refuse">{item.name} is already listed. Edit it in its own row.</p> : null}
                {MODES.map((mode) => (
                  <div key={mode} className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-x-2" data-slot="environment-value" data-environment={mode}>
                    <EnvironmentLabel mode={mode} className="min-h-(--panel-control-height)" />
                    {item.values[mode] !== undefined ? (
                      <ValueControl
                        key={draftState.latest.revision}
                        name={`${label} in ${ENVIRONMENT_NAMES[mode]}`}
                        value={item.values[mode]!}
                        placeholder="Blank"
                        sensitive={true}
                        disabled={locked}
                        onChange={(value) => changeCreated(item.key, { value }, mode)}
                      />
                    ) : (
                      <p className="m-0 flex min-h-(--panel-control-height) items-center text-caption text-graphite">{pathOf(mode)} is unavailable.</p>
                    )}
                  </div>
                ))}
                <p className="m-0 text-caption text-graphite">Added to both files. A blank value writes an empty line.</p>
                <button
                  className={cx(buttonClasses({ variant: "link" }), "justify-self-start text-caption")}
                  disabled={!!draftState.busy}
                  onClick={() => removeCreated(item.key)}
                >
                  Remove new variable
                </button>
              </li>
            );
          })}
        </ul>
        <div data-slot="environment-variables">
          {ungrouped.length ? <ul className="m-0 list-none p-0" key="ungrouped" data-slot="input-file-entries">{ungrouped.map(variable)}</ul> : null}
          {groups.map((group) => (
            <div key={group.key} data-slot="environment-variable-group">
              <h4 className="m-[var(--space-4)_0_0] text-caption font-medium text-balance text-graphite" data-slot="input-group-heading">
                {group.title}
              </h4>
              {group.note ? <p className="mt-0.5 mb-1 text-caption text-graphite">{group.note}</p> : null}
              <ul className="m-0 list-none p-0" data-slot="input-file-entries">
                {group.rows.map(variable)}
              </ul>
            </div>
          ))}
        </div>
        {query && !matches.length ? <p className="mt-0 mb-2 text-caption text-graphite">No variables match this search.</p> : null}
        {!query && !missingIn && !rows.length && !created.length && writable.length ? (
          <p role="status" className={inspectorNoteClasses}>No environment variables yet. Add one to both files.</p>
        ) : null}
      </section>
      <InspectorDisclosure title="Files" contentClassName="grid gap-4">
        {MODES.map((mode) => (
          <div key={mode} className="grid justify-items-start gap-1.5" data-slot="environment-file" data-environment={mode}>
            <EnvironmentLabel mode={mode} />
            {draft.description(ids[mode]).trim() ? (
              <p className="m-0 text-caption text-ink" data-slot="environment-file-description">{draft.description(ids[mode])}</p>
            ) : null}
            {exists[mode] ? (
              <a className={cx(buttonClasses({ variant: "link" }), "text-caption wrap-anywhere")} href={editorLink(snapshot.repositoryRoot, location(pathOf(mode)))}>
                Open {pathOf(mode)}
              </a>
            ) : (
              <span className="text-caption text-refuse wrap-anywhere">{pathOf(mode)} is missing.</span>
            )}
            <a
              className={cx(buttonClasses({ variant: "link" }), "text-caption wrap-anywhere")}
              href={editorLink(snapshot.repositoryRoot, location(files[mode]?.template ?? `${pathOf(mode)}.template`))}
            >
              Template: {files[mode]?.template ?? `${pathOf(mode)}.template`}
            </a>
            <details className="w-full" data-slot="environment-file-description-editor">
              <InspectorSummary className="cursor-pointer text-caption text-graphite">
                {draft.description(ids[mode]).trim() ? "Edit description" : "Add description"}
              </InspectorSummary>
              <Description entity={ids[mode]} inline shared={false} />
            </details>
          </div>
        ))}
        <p className={inspectorNoteClasses}>
          Studio creates a missing file from its own template when it starts, and never overwrites one.
          Values stay out of the map, secrets stay withheld until you reveal one, and production is never
          filled from development. Saving does not synthesize or deploy.
        </p>
      </InspectorDisclosure>
    </>
  );
}
