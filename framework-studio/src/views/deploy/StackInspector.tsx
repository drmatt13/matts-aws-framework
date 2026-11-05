import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronRight, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type {
  InspectionJson, StackChangeSet, StackInspectionRequest, StackInspectionSection,
  StackInspectionSections, StackOverview, StackParameter,
} from "../../../shared/stack-inspection";
import { inspectStack, stackInspectionKey, type StackInspectionScope } from "../../deploy/stack-inspection";
import { sameDeploymentObservation } from "../../deploy/context";
import { dialogBodyClasses, dialogClasses, dialogHeaderClasses, dialogSubtitleClasses, dialogTitleClasses } from "../../inspector-ui";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/FormControls";
import { IconButton } from "../../ui/IconButton";
import { cx } from "../../ui/classes";
import { documentSubheadingClasses, documentSupportClasses, documentTitleClasses } from "../DocumentUI";
import { navigationItemClasses } from "../NavigationStrip";

const tabs = [
  ["overview", "Overview"], ["resources", "Resources"], ["events", "Events"],
  ["outputs", "Outputs"], ["parameters", "Parameters"], ["template", "Template"],
  ["tags", "Tags"], ["change-sets", "Change sets"], ["dependencies", "Dependencies"],
] as const;
type Tab = typeof tabs[number][0];
const readPolicy = { retry: false, staleTime: 30_000, gcTime: 5 * 60_000,
  refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const codeClasses = "m-0 max-h-100 overflow-auto rounded-md border border-rule bg-paper p-3 font-mono text-caption whitespace-pre-wrap wrap-anywhere";

function timestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[minmax(140px,1fr)_minmax(0,3fr)] gap-x-4 gap-y-1 border-b border-rule py-2 last:border-b-0 vp-540:grid-cols-1">
    <dt className="text-caption text-graphite">{label}</dt>
    <dd className="m-0 min-w-0 text-caption wrap-anywhere">{children ?? "—"}</dd>
  </div>;
}
function Facts({ children }: { readonly children: ReactNode }) {
  return <dl className="m-0 grid min-w-0">{children}</dl>;
}
function Empty({ children }: { readonly children: ReactNode }) {
  return <p className={documentSupportClasses}>{children}</p>;
}
function ReadProblem({ error, retry, label }: { readonly error: Error; readonly retry: () => void; readonly label: string }) {
  return <div role="alert" className="grid min-w-0 justify-items-start gap-2 rounded-md border border-refuse p-3">
    <p className="m-0 text-caption wrap-anywhere">{error.message}</p>
    <Button variant="quiet" size="compact" onClick={retry}>Retry {label.toLowerCase()}</Button>
  </div>;
}
function ReadHeader({ label, observedAt, fetching, refresh }: {
  readonly label: string; readonly observedAt?: string; readonly fetching: boolean; readonly refresh: () => void;
}) {
  return <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
    <div className="grid min-w-0 gap-1">
      <h3 className={documentTitleClasses}>{label}</h3>
      {observedAt ? <p className={documentSupportClasses}>Observed {timestamp(observedAt)}</p> : null}
    </div>
    <Button variant="quiet" size="compact" disabled={fetching} onClick={refresh} aria-label={`Refresh ${label.toLowerCase()}`}>
      <RefreshCw size={14} aria-hidden />{fetching ? "Refreshing…" : "Refresh"}
    </Button>
  </div>;
}
function Table({ label, columns, children }: { readonly label: string; readonly columns: readonly string[]; readonly children: ReactNode }) {
  return <div role="region" aria-label={`${label} table`} tabIndex={0} className="min-w-0 max-w-full overflow-x-auto rounded-md border border-rule focus-visible:outline-offset-[-2px]">
    <table className="w-full border-collapse text-caption [&_th]:bg-wash [&_th]:text-left [&_th]:font-medium [&_th]:text-ink [&_th]:whitespace-nowrap [&_th]:px-3 [&_th]:py-2 [&_td]:border-t [&_td]:border-rule [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:wrap-anywhere">
      <thead><tr>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}
function Status({ value }: { readonly value: string }) {
  return <span className={cx("font-mono text-caption", /FAILED|ROLLBACK/.test(value) ? "text-refuse" : "text-ink")}>{value}</span>;
}
function Json({ value }: { readonly value: unknown }) {
  return <pre className={codeClasses}>{JSON.stringify(value, null, 2)}</pre>;
}

type Options = Pick<StackInspectionRequest, "stackId" | "stage" | "changeSetId" | "exportName">;
/** Only the mounted section reads AWS. Changing sections never borrows another section's data. */
function SectionRead<S extends StackInspectionSection>({ scope, section, options, label, children }: {
  readonly scope: StackInspectionScope; readonly section: S; readonly options: Options; readonly label: string;
  readonly children: (pages: readonly StackInspectionSections[S][]) => ReactNode;
}) {
  const read = useInfiniteQuery({
    queryKey: stackInspectionKey(scope, section, options),
    queryFn: ({ signal, pageParam }) => inspectStack(scope, section, { ...options, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => "nextCursor" in page ? page.nextCursor : undefined,
    ...readPolicy,
  });
  const pages = read.data?.pages;
  const observedAt = pages?.at(-1)?.observedAt;
  return <div className="grid min-w-0 gap-3" aria-busy={read.isFetching}>
    <ReadHeader label={label} observedAt={observedAt} fetching={read.isFetching} refresh={() => void read.refetch()} />
    {read.error ? <ReadProblem error={read.error} retry={() => void (read.isFetchNextPageError ? read.fetchNextPage() : read.refetch())} label={label} /> : null}
    {read.isPending ? <p role="status" className={documentSupportClasses}>Loading {label.toLowerCase()}…</p> : null}
    {pages ? children(pages) : null}
    {read.hasNextPage ? <div className="flex justify-start"><Button variant="quiet" size="compact" disabled={read.isFetching} onClick={() => void read.fetchNextPage()}>
      {read.isFetchingNextPage ? "Loading more…" : `Load more ${label.toLowerCase()}`}
    </Button></div> : null}
  </div>;
}

function Overview({ value }: { readonly value: StackOverview }) {
  return <div className="grid min-w-0 gap-4">
    {value.description ? <p className="m-0 text-body wrap-anywhere">{value.description}</p> : null}
    <Facts>
      <Fact label="Stack name">{value.name}</Fact>
      <Fact label="Stack ID"><code>{value.stackId}</code></Fact>
      <Fact label="Status"><Status value={value.status} /></Fact>
      {value.detailedStatus ? <Fact label="Detailed status">{value.detailedStatus}</Fact> : null}
      {value.statusReason ? <Fact label="Status reason">{value.statusReason}</Fact> : null}
      <Fact label="Created">{timestamp(value.createdAt)}</Fact>
      <Fact label="Last updated">{timestamp(value.updatedAt)}</Fact>
      {value.deletedAt ? <Fact label="Deleted">{timestamp(value.deletedAt)}</Fact> : null}
      <Fact label="Termination protection">{value.terminationProtection ? "Enabled" : "Disabled"}</Fact>
      <Fact label="Rollback on failure">{value.disableRollback ? "Disabled" : "Enabled"}</Fact>
      {value.retainExceptOnCreate !== undefined ? <Fact label="Retain except on create">{value.retainExceptOnCreate ? "Enabled" : "Disabled"}</Fact> : null}
      {value.deletionMode ? <Fact label="Deletion mode">{value.deletionMode}</Fact> : null}
      <Fact label="Stack timeout">{value.timeoutMinutes === undefined ? "Not specified" : `${value.timeoutMinutes} minutes`}</Fact>
      <Fact label="IAM role">{value.roleArn ? <code>{value.roleArn}</code> : "Default caller permissions"}</Fact>
      <Fact label="Parent stack">{value.parentId ? <code>{value.parentId}</code> : "None"}</Fact>
      <Fact label="Root stack">{value.rootId ? <code>{value.rootId}</code> : "This stack"}</Fact>
      <Fact label="Capabilities">{value.capabilities.length ? value.capabilities.join(", ") : "None"}</Fact>
      <Fact label="Drift status">{value.drift.status}</Fact>
      <Fact label="Last drift check">{timestamp(value.drift.lastCheckedAt)}</Fact>
      <Fact label="Notification topics">{value.notificationArns.length ? value.notificationArns.map(arn => <code className="block" key={arn}>{arn}</code>) : "None"}</Fact>
    </Facts>
    <section className="grid min-w-0 gap-2" aria-label="Rollback configuration">
      <h4 className={documentSubheadingClasses}>Rollback configuration</h4>
      <Facts>
        <Fact label="Monitoring period">{value.rollback.monitoringMinutes === undefined ? "Not specified" : `${value.rollback.monitoringMinutes} minutes`}</Fact>
        <Fact label="CloudWatch alarms">{value.rollback.triggers.length ? value.rollback.triggers.map(trigger => <span className="block" key={trigger.arn}><code>{trigger.arn}</code> · {trigger.type}</span>) : "None"}</Fact>
      </Facts>
    </section>
    <section className="grid min-w-0 gap-2" aria-label="Stack policy">
      <h4 className={documentSubheadingClasses}>Stack policy</h4>
      {value.policy.ok ? value.policy.value.body ? <pre className={codeClasses}>{value.policy.value.body}</pre> : <Empty>No stack policy.</Empty>
        : <p role="note" className="m-0 border-l-2 border-local pl-2 text-caption wrap-anywhere">Stack policy unavailable: {value.policy.problem.message}</p>}
    </section>
  </div>;
}

function Resources({ scope, stackId }: { readonly scope: StackInspectionScope; readonly stackId: string }) {
  return <SectionRead scope={scope} section="resources" options={{ stackId }} label="Resources">{pages => {
    const rows = pages.flatMap(page => page.items);
    return rows.length ? <Table label="Resources" columns={["Logical ID / physical ID", "Type", "Status"]}>{rows.map(row => <tr key={row.logicalId}>
      <td className="min-w-56"><code>{row.logicalId}</code>{row.physicalId ? <code className="mt-1 block text-graphite">{row.physicalId}</code> : null}
        <details className="mt-1"><summary className="cursor-pointer py-1 text-graphite">Resource details</summary><Facts>
          <Fact label="Last updated">{timestamp(row.updatedAt)}</Fact>
          <Fact label="Status reason">{row.statusReason ?? "None"}</Fact>
          <Fact label="Drift status">{row.drift?.status ?? "NOT_CHECKED"}</Fact>
          <Fact label="Last drift check">{timestamp(row.drift?.lastCheckedAt)}</Fact>
          {row.module?.logicalIdHierarchy ? <Fact label="Module logical IDs">{row.module.logicalIdHierarchy}</Fact> : null}
          {row.module?.typeHierarchy ? <Fact label="Module types">{row.module.typeHierarchy}</Fact> : null}
        </Facts></details>
      </td><td className="min-w-44"><code>{row.type}</code></td><td className="min-w-40"><Status value={row.status} />{row.statusReason ? <p className="mt-1 mb-0">{row.statusReason}</p> : null}</td>
    </tr>)}</Table> : <Empty>No resources in this stack.</Empty>;
  }}</SectionRead>;
}
function Events({ scope, stackId }: { readonly scope: StackInspectionScope; readonly stackId: string }) {
  return <SectionRead scope={scope} section="events" options={{ stackId }} label="Events">{pages => {
    const rows = pages.flatMap(page => page.items);
    return rows.length ? <Table label="Events" columns={["Time", "Logical ID / type", "Status / reason"]}>{rows.map(row => <tr key={row.id}>
      <td className="min-w-40"><time dateTime={row.time}>{timestamp(row.time)}</time></td>
      <td className="min-w-56"><code>{row.logicalId}</code><code className="mt-1 block text-graphite">{row.type}</code>
        <details className="mt-1"><summary className="cursor-pointer py-1 text-graphite">Event details</summary><Facts>
          <Fact label="Event ID"><code>{row.id}</code></Fact><Fact label="Physical ID"><code>{row.physicalId ?? "—"}</code></Fact>
          {row.clientRequestToken ? <Fact label="Client request token"><code>{row.clientRequestToken}</code></Fact> : null}
          {row.detailedStatus ? <Fact label="Detailed status">{row.detailedStatus}</Fact> : null}
        </Facts></details>
      </td><td className="min-w-56"><Status value={row.status} />{row.reason ? <p className="mt-1 mb-0">{row.reason}</p> : null}</td>
    </tr>)}</Table> : <Empty>No CloudFormation events are available.</Empty>;
  }}</SectionRead>;
}
function ParameterRows({ rows }: { readonly rows: readonly StackParameter[] }) {
  return rows.length ? <Table label="Parameters" columns={["Key", "Value", "Type / description"]}>{rows.map(row => <tr key={row.key}>
    <td className="min-w-40"><code>{row.key}</code></td><td className="min-w-40"><code>{row.value}</code>{row.masked ? <span className="mt-1 block text-graphite">Masked</span> : null}{row.resolvedValue !== undefined ? <span className="mt-1 block text-graphite">Resolved value: <code>{row.resolvedValue}</code></span> : null}{row.usePreviousValue ? <span className="mt-1 block text-graphite">Uses previous value</span> : null}</td>
    <td className="min-w-40">{row.type ? <code>{row.type}</code> : null}{row.description ? <p className="mt-1 mb-0">{row.description}</p> : null}</td>
  </tr>)}</Table> : <Empty>No parameters.</Empty>;
}
function Parameters({ scope, stackId }: { readonly scope: StackInspectionScope; readonly stackId: string }) {
  return <SectionRead scope={scope} section="parameters" options={{ stackId }} label="Parameters">{pages => <>
    {pages[0]?.maskingProblem ? <p role="note" className="m-0 border-l-2 border-local pl-2 text-caption wrap-anywhere">Parameter values are masked because template visibility could not be verified: {pages[0].maskingProblem.message}</p> : null}
    <ParameterRows rows={pages.flatMap(page => page.items)} />
  </>}</SectionRead>;
}
function Outputs({ scope, stackId }: { readonly scope: StackInspectionScope; readonly stackId: string }) {
  return <SectionRead scope={scope} section="outputs" options={{ stackId }} label="Outputs">{pages => {
    const rows = pages.flatMap(page => page.items);
    return rows.length ? <Table label="Outputs" columns={["Key", "Value", "Export / description"]}>{rows.map(row => <tr key={row.key}>
      <td className="min-w-40"><code>{row.key}</code></td><td className="min-w-56"><code>{row.value}</code></td><td className="min-w-40">{row.exportName ? <code>{row.exportName}</code> : null}{row.description ? <p className="mt-1 mb-0">{row.description}</p> : null}</td>
    </tr>)}</Table> : <Empty>No outputs.</Empty>;
  }}</SectionRead>;
}
function Tags({ scope, stackId }: { readonly scope: StackInspectionScope; readonly stackId: string }) {
  return <SectionRead scope={scope} section="tags" options={{ stackId }} label="Tags">{pages => {
    const rows = pages.flatMap(page => page.items);
    return rows.length ? <Table label="Tags" columns={["Key", "Value"]}>{rows.map(row => <tr key={row.key}><td><code>{row.key}</code></td><td>{row.value}</td></tr>)}</Table> : <Empty>No tags.</Empty>;
  }}</SectionRead>;
}
function Template({ scope, stackId }: { readonly scope: StackInspectionScope; readonly stackId: string }) {
  const id = useId();
  const [stage, setStage] = useState<"Original" | "Processed">("Original");
  const [copy, setCopy] = useState("");
  const body = useRef<string | undefined>(undefined);
  useEffect(() => { setCopy(""); }, [stage]);
  return <div className="grid min-w-0 gap-3">
    <div className="flex flex-wrap items-center gap-2"><label className="text-caption" htmlFor={`${id}-stage`}>Template version</label>
      <Select id={`${id}-stage`} value={stage} onChange={event => setStage(event.target.value as typeof stage)}><option>Original</option><option>Processed</option></Select>
    </div>
    <SectionRead scope={scope} section="template" options={{ stackId, stage }} label="Template">{pages => {
      const value = pages[0]!;
      body.current = value.body;
      return <>
        <div className="flex flex-wrap items-center gap-2"><span className="text-caption text-graphite">{value.format.toUpperCase()} · {value.stage}</span>
          <Button variant="quiet" size="compact" onClick={async () => {
            setCopy("");
            try { await navigator.clipboard.writeText(body.current ?? ""); setCopy("Template copied."); }
            catch { setCopy("Copy unavailable. Select the template text to copy it."); }
          }}>Copy template</Button><span role="status" className="text-caption text-graphite">{copy}</span>
        </div>
        {value.redactedDefaults.length ? <p role="note" className="m-0 text-caption text-graphite">NoEcho defaults are masked: {value.redactedDefaults.join(", ")}.</p> : null}
        <pre tabIndex={0} aria-label={`${stage} stack template`} className={codeClasses}>{value.body}</pre>
      </>;
    }}</SectionRead>
  </div>;
}
function ChangeFacts({ value }: { readonly value: StackChangeSet }) {
  const { summary } = value;
  return <Facts>
    <Fact label="Change set name">{summary.name}</Fact><Fact label="Change set ID"><code>{summary.id}</code></Fact>
    <Fact label="Status"><Status value={summary.status} /></Fact><Fact label="Execution status">{summary.executionStatus}</Fact>
    <Fact label="Status reason">{summary.statusReason ?? "None"}</Fact><Fact label="Description">{summary.description}</Fact>
    <Fact label="Created">{timestamp(summary.createdAt)}</Fact><Fact label="Type">{summary.type}</Fact>
    <Fact label="Nested stacks">{summary.includeNestedStacks ? "Included" : "Not included"}</Fact>
    {summary.parentId ? <Fact label="Parent change set"><code>{summary.parentId}</code></Fact> : null}
    {summary.rootId ? <Fact label="Root change set"><code>{summary.rootId}</code></Fact> : null}
    <Fact label="Capabilities">{value.capabilities.join(", ") || "None"}</Fact>
    <Fact label="Notification topics">{value.notificationArns.join(", ") || "None"}</Fact>
    {value.onStackFailure ? <Fact label="On stack failure">{value.onStackFailure}</Fact> : null}
    <Fact label="Import existing resources">{value.importExistingResources ? "Enabled" : "Disabled"}</Fact>
  </Facts>;
}
function changeResource(value: InspectionJson): Record<string, InspectionJson> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const resource = (value as Record<string, InspectionJson>).ResourceChange;
  return resource && typeof resource === "object" && !Array.isArray(resource) ? resource as Record<string, InspectionJson> : undefined;
}
function ChangeSets({ scope, stackId }: { readonly scope: StackInspectionScope; readonly stackId: string }) {
  const [selected, setSelected] = useState<string>();
  const back = useRef<HTMLButtonElement>(null);
  const lastSelected = useRef<string>(undefined);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (selected) back.current?.focus({ preventScroll: true });
    else if (lastSelected.current) rowButtons.current.get(lastSelected.current)?.focus({ preventScroll: true });
  }, [selected]);
  return selected ? <div className="grid min-w-0 gap-3">
    <div><Button ref={back} variant="link" onClick={() => setSelected(undefined)}>Back to change sets</Button></div>
    <SectionRead scope={scope} section="change-set" options={{ stackId, changeSetId: selected }} label="Change set">{pages => {
      const value = pages[0]!;
      const changes = pages.flatMap(page => page.items);
      return <><ChangeFacts value={value} />
        <section className="grid min-w-0 gap-2"><h4 className={documentSubheadingClasses}>Resource changes</h4>
          {changes.length ? <ul className="m-0 grid min-w-0 list-none gap-2 p-0">{changes.map((change, index) => {
            const resource = changeResource(change);
            return <li key={index}><details className="min-w-0 rounded-md border border-rule p-3"><summary className="cursor-pointer text-caption wrap-anywhere">
              {resource ? <><strong>{String(resource.Action ?? "Change")}</strong>{" · "}<code>{String(resource.LogicalResourceId ?? "Resource")}</code>{" · "}{String(resource.ResourceType ?? "")}{resource.Replacement ? ` · replacement ${String(resource.Replacement)}` : ""}</> : `Change ${index + 1}`}
            </summary><div className="mt-2"><Json value={change} /></div></details></li>;
          })}</ul> : <Empty>No resource changes.</Empty>}
        </section>
        <details className="min-w-0"><summary className="cursor-pointer py-1 text-caption">Change set parameters</summary><div className="mt-2 grid gap-2">{value.maskingProblem ? <p className="m-0 border-l-2 border-local pl-2 text-caption">Parameter values are masked: {value.maskingProblem.message}</p> : null}<ParameterRows rows={value.parameters} /></div></details>
        <details className="min-w-0"><summary className="cursor-pointer py-1 text-caption">Change set tags and rollback configuration</summary><div className="mt-2 grid gap-2"><Json value={{ tags: value.tags, rollback: value.rollback }} /></div></details>
      </>;
    }}</SectionRead>
  </div> : <SectionRead scope={scope} section="change-sets" options={{ stackId }} label="Change sets">{pages => {
    const rows = pages.flatMap(page => page.items);
    return rows.length ? <ul className="m-0 grid list-none gap-2 p-0">{rows.map(row => <li key={row.id}>
      <button ref={element => { if (element) rowButtons.current.set(row.id, element); else rowButtons.current.delete(row.id); }} type="button" aria-label={`Inspect change set ${row.name}`} className="grid min-w-0 w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-rule bg-transparent p-3 text-left text-ink hover:bg-wash" onClick={() => { lastSelected.current = row.id; setSelected(row.id); }}>
        <span className="grid min-w-0 gap-1 text-caption wrap-anywhere"><strong>{row.name}</strong><span><Status value={row.status} />{row.executionStatus ? ` · ${row.executionStatus}` : ""}</span>{row.createdAt ? <span className="text-graphite">{timestamp(row.createdAt)}</span> : null}{row.statusReason ? <span>{row.statusReason}</span> : null}{row.description ? <span className="text-graphite">{row.description}</span> : null}</span>
        <ChevronRight size={16} aria-hidden />
      </button>
    </li>)}</ul> : <Empty>No CloudFormation change sets. Studio synthesis plans are reviewed separately on the deployment page.</Empty>;
  }}</SectionRead>;
}
function ExportImporters({ scope, stackId, exportName }: { readonly scope: StackInspectionScope; readonly stackId: string; readonly exportName: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer py-1">Importing stacks for {exportName}</summary>
    {open ? <div className="mt-2"><SectionRead scope={scope} section="export-imports" options={{ stackId, exportName }} label="Importing stacks">{pages => {
      const names = pages.flatMap(page => page.items);
      return names.length ? <ul className="m-0 min-w-0 pl-5 text-caption wrap-anywhere">{names.map(name => <li key={name}><code>{name}</code></li>)}</ul> : <Empty>No importing stacks.</Empty>;
    }}</SectionRead></div> : null}
  </details>;
}
function Dependencies({ scope, stackId }: { readonly scope: StackInspectionScope; readonly stackId: string }) {
  return <SectionRead scope={scope} section="dependencies" options={{ stackId }} label="Dependencies">{pages => {
    const value = pages[0]!;
    return <>
      <section className="grid min-w-0 gap-2"><h4 className={documentSubheadingClasses}>Exports and importing stacks</h4>
        {value.exports.length ? <Table label="Exports" columns={["Export", "Value", "Imported by"]}>{value.exports.map(row => <tr key={row.name}><td><code>{row.name}</code></td><td><code>{row.value}</code></td><td><ExportImporters scope={scope} stackId={stackId} exportName={row.name} /></td></tr>)}</Table> : <Empty>No exports.</Empty>}
      </section>
      <section className="grid min-w-0 gap-2"><h4 className={documentSubheadingClasses}>Imported exports</h4>
        {value.imports.length ? <ul className="m-0 min-w-0 pl-5 text-caption wrap-anywhere">{value.imports.map(name => <li key={name}><code>{name}</code></li>)}</ul> : <Empty>No imported exports found.</Empty>}
        {value.importsNote ? <p className={documentSupportClasses}>{value.importsNote}</p> : null}
      </section>
    </>;
  }}</SectionRead>;
}

/** A read-only destination inspector; deployment actions remain in the reviewed deployment flow. */
export function StackInspector({ scope, onClose, returnFocusRef }: {
  readonly scope: StackInspectionScope; readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const id = useId();
  const overview = useQuery({ queryKey: stackInspectionKey(scope, "overview"),
    queryFn: ({ signal }) => inspectStack(scope, "overview", {}, signal),
    // The parent remounts on actor/destination changes; a source-only refresh
    // may retain the same immutable stack while its observation is rechecked.
    placeholderData: (previous, previousQuery) => {
      const previousScope = previousQuery?.queryKey[2] as StackInspectionScope | undefined;
      return sameDeploymentObservation(previousScope, scope) && previousScope?.stack === scope.stack ? previous : undefined;
    }, ...readPolicy });
  useEffect(() => {
    const element = dialog.current!;
    const opener = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    element.showModal();
    return () => { element.close(); if (opener?.isConnected && !opener.hasAttribute("disabled")) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [tab]);
  const stackId = overview.data?.stackId;
  const section = stackId ? tab === "resources" ? <Resources scope={scope} stackId={stackId} />
    : tab === "events" ? <Events scope={scope} stackId={stackId} />
    : tab === "outputs" ? <Outputs scope={scope} stackId={stackId} />
    : tab === "parameters" ? <Parameters scope={scope} stackId={stackId} />
    : tab === "template" ? <Template key={stackId} scope={scope} stackId={stackId} />
    : tab === "tags" ? <Tags scope={scope} stackId={stackId} />
    : tab === "change-sets" ? <ChangeSets key={stackId} scope={scope} stackId={stackId} />
    : tab === "dependencies" ? <Dependencies scope={scope} stackId={stackId} /> : null : null;
  return <dialog ref={dialog} aria-labelledby={`${id}-title`} className={dialogClasses({ size: "wide" })} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className={cx(dialogHeaderClasses, "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3")}>
      <div className="min-w-0"><h2 id={`${id}-title`} className={cx(dialogTitleClasses, "text-balance wrap-anywhere")}>Stack details · {scope.stack}</h2>
        <p className={cx(dialogSubtitleClasses, "mt-1 mb-0 wrap-anywhere")}>{scope.deployment} · {scope.mode === "dev" ? "Development" : "Production"} · profile {scope.profile} · {scope.account} · {scope.region}</p>
      </div><IconButton aria-label="Close stack details" variant="quiet" onClick={onClose}><X size={18} aria-hidden /></IconButton>
    </header>
    <div role="tablist" aria-label="Stack details" className="flex min-w-0 flex-none gap-1 overflow-x-auto border-b border-rule px-4 py-2 scrollbar-thin" onKeyDown={event => {
      const index = tabs.findIndex(([value]) => value === tab);
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
      if (next === undefined) return;
      event.preventDefault(); setTab(tabs[next]![0]); tabButtons.current[next]?.focus({ preventScroll: true });
      tabButtons.current[next]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }}>{tabs.map(([value, label], index) => <button key={value} ref={element => { tabButtons.current[index] = element; }} type="button" role="tab" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} id={`${id}-tab-${value}`} aria-controls={`${id}-panel-${value}`} className={cx(navigationItemClasses, tab === value && "border-rule bg-wash text-ink")} onClick={event => { setTab(value); event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }}>{label}</button>)}</div>
    <div ref={content} className={cx(dialogBodyClasses, "min-w-0")}>
      {tabs.map(([value]) => <section key={value} role="tabpanel" tabIndex={0} hidden={value !== tab} id={`${id}-panel-${value}`} aria-labelledby={`${id}-tab-${value}`} className="grid min-w-0 gap-3">
        {value === tab ? <>
        {tab === "overview" || !stackId ? <>
          <ReadHeader label="Overview" observedAt={overview.data?.observedAt} fetching={overview.isFetching} refresh={() => void overview.refetch()} />
          {overview.error ? <ReadProblem error={overview.error} retry={() => void overview.refetch()} label="Overview" /> : null}
          {overview.isPending ? <p role="status" className={documentSupportClasses}>Loading stack overview…</p> : null}
          {overview.data ? <Overview value={overview.data} /> : null}
        </> : section}
        </> : null}
      </section>)}
    </div>
  </dialog>;
}
