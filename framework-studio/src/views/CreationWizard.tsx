import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { dialogClasses, dialogHeaderClasses, dialogTitleClasses, dialogBodyClasses, dialogFooterClasses } from "../inspector-ui";
import { useEffect, useId, useRef, useState } from "react";
import { CREATORS, CreationValidationError, creationDefaults, defaultImplementationDirectory, networkCreationProblem, readCreationRequest, webSocketCreationCondition, type CreationField } from "../../shared/creation";
import type { CreationEntry } from "../draft";
import { useStudio } from "../studio";
import { InspectorSwitch } from "./InspectorUI";
import { InterfaceEndpointPicker } from "./InterfaceEndpointPicker";
import { TagRows } from "./Tags";
import { deploymentSettingLabel } from "../deployment";

/** Forms are part of InspectorDraft: review/back, source conflicts, navigation,
 * browser exit, discard and apply all share the existing session lifecycle. */
export function CreationWizard({ entry, back }: { readonly entry: CreationEntry; readonly back: () => void }) {
  const { draft, draftState, model, snapshot, live } = useStudio();
  const dialog = useRef<HTMLDialogElement>(null);
  const prefix = useId();
  const [tagError, setTagError] = useState<string>();
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const touch = (field: string) => setTouched(current => current.has(field) ? current : new Set([...current, field]));
  const creator = CREATORS[entry.resourceKind];
  const catalogInput = entry.resourceKind === "input" || entry.resourceKind === "secret";
  const disabled = !!draftState.busy || draft.conflict || !!model.stale || live.evaluating;
  useEffect(() => {
    const element = dialog.current!;
    if (!draftState.reviewOpen && !draftState.pendingNavigation) element.showModal();
    return () => element.close();
  }, [draftState.reviewOpen, draftState.pendingNavigation]);
  let problem: CreationValidationError | undefined;
  const newWebSocket = (entry.resourceKind === "function" || entry.resourceKind === "route") && entry.form.category === "webSocket" && !entry.form.existingTarget;
  let webSocketCondition: ReturnType<typeof webSocketCreationCondition>;
  let webSocketConditionProblem: CreationValidationError | undefined;
  if (newWebSocket) try { webSocketCondition = webSocketCreationCondition(Object.values(snapshot.models)); }
  catch (error) { if (error instanceof CreationValidationError) webSocketConditionProblem = error; }
  try {
    const request = readCreationRequest({ kind: entry.resourceKind, ...entry.form });
    if (request.kind === "vpc") problem = networkCreationProblem(request, model.networks ?? []);
    if (newWebSocket && entry.form.deploy !== "none") {
      problem = webSocketConditionProblem;
      if (webSocketCondition && entry.form.deploy !== "both") problem = new CreationValidationError("deploy", "Choose Use $connect condition or Off for this WebSocket handler.");
    }
  }
  catch (error) { if (error instanceof CreationValidationError) problem = error; }
  const fields = creator.fields.filter((field) => {
    if (entry.resourceKind === "auth-provider") {
      if (["issuer", "clientId", "secretEnvName", "scopes"].includes(field.key)) return entry.form.providerType === "oidc";
      if (field.key === "metadataUrl") return entry.form.providerType === "saml";
      if (["description", "tags"].includes(field.key)) return false;
    }
    if (entry.resourceKind === "stack" && ["readBucketArn", "readPrefix"].includes(field.key)) return entry.form.template === "identity-pool";
    const lambda = entry.resourceKind === "function" || entry.resourceKind === "route";
    if (!lambda) return true;
    if (entry.form.category === "event" && ["path", "method", "auth"].includes(field.key)) return false;
    if (entry.form.category === "webSocket" && ["method", "auth"].includes(field.key)) return false;
    if (entry.resourceKind === "route" && entry.form.existingTarget && !["description", "category", "path", "method", "existingTarget", "tags"].includes(field.key)) return false;
    return true;
  });
  const render = (field: CreationField) => {
    const id = `${prefix}-${field.key}`;
    const serverError = draftState.error?.startsWith(`${field.key}: `) ? draftState.error.slice(field.key.length + 2) : undefined;
    const error = serverError ?? (problem?.field === field.key && touched.has(field.key) ? problem.message : undefined);
    const selector = webSocketCondition && model.resources.find(resource => resource.id === webSocketCondition.resource);
    const help = field.key === "deploy" && webSocketCondition ? `Copies $connect's current condition: ${selector?.fromEnv ?? webSocketCondition.resource} equals ${JSON.stringify(webSocketCondition.equals)}. Each environment resolves its own value. Off keeps the new handler disabled.` : field.key === "deploy" && webSocketConditionProblem ? webSocketConditionProblem.message : field.help;
    const describedBy = [help ? `${id}-help` : undefined, error ? `${id}-error` : undefined].filter(Boolean).join(" ") || undefined;
    const value = entry.form[field.key];
    const update = (next: string | number | boolean) => {
      touch(field.key);
      const form = { ...entry.form, [field.key]: next };
      if (field.key === "existingTarget" && next) { const target = model.targets.find(target => target.ref === next); if (target) form.id = target.id; }
      const envName = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_").toUpperCase();
      const route = (name: string, category: unknown) => entry.resourceKind === "service" ? `/${name}/*` : category === "webSocket" ? name : `/${name}`;
      if (field.key === "vpc" && next && form.subnet === "none") form.subnet = "private";
      if (field.key === "vpc" && !next && ["function", "route"].includes(entry.resourceKind)) form.subnet = "none";
      if (field.key === "id" && typeof next === "string") {
        const old = String(entry.form.id);
        if ("envName" in form && (!form.envName || form.envName === envName(old))) form.envName = envName(next);
        if ("className" in form && (!form.className || form.className === `${old[0]?.toUpperCase() ?? ""}${old.slice(1)}Stack`)) form.className = `${next[0]?.toUpperCase() ?? ""}${next.slice(1)}Stack`;
        if (entry.resourceKind !== "agent" && "path" in form && (!form.path || form.path === route(old, form.category))) form.path = route(next, form.category);
      }
      if (field.key === "category" && (!form.path || form.path === route(String(form.id), entry.form.category))) form.path = route(String(form.id), next);
      if (field.key === "bindingResource" && !form.bindingVariable) {
        const resource = model.resources.find((resource) => resource.id === next);
        if (resource?.fromEnv) form.bindingVariable = resource.fromEnv + (resource.kind === "secret" && !["service", "task"].includes(entry.resourceKind) ? "_SECRET_ARN" : "");
      }
      if (field.key === "consumer" && !form.consumerVariable) {
        const target = model.targets.find((target) => target.ref === next);
        if (target) form.consumerVariable = String(form.envName) + (entry.resourceKind === "secret" && target.kind !== "service" && target.kind !== "task" ? "_SECRET_ARN" : "");
      }
      draft.setCreation(entry.resourceKind, form);
    };
    const options = field.key === "vpc" ? ["", ...(model.networks ?? []).map(network => network.id)] : field.key === "bindingResource" ? ["", ...model.resources.filter((resource) => resource.kind === "input" || resource.kind === "secret").map((resource) => resource.id)]
      : field.key === "consumer" ? ["", ...model.targets.map((target) => target.ref)]
      : field.key === "existingTarget" ? ["", ...model.targets.filter((target) => target.kind === "lambda" && target.role === entry.form.category).map((target) => target.ref)] : field.options;
    const appendOptions = field.key === "steps" ? model.targets.filter((target) => target.kind === "task" || target.role === "event").map((target) => target.ref)
      : field.key === "tools" ? model.targets.filter((target) => target.role === "tool" && (entry.form.auth || !target.auth)).map((target) => target.id) : undefined;
    const remainingOptions = appendOptions?.filter((option) => !String(value).split(",").map((part) => part.trim()).includes(option));
    const optionLabel = (option: string) => {
      if (field.key === "implementation") return option === "existing" ? "Use existing code" : "Create starter files";
      if (field.key === "starter") return option === "model" ? "Model and tools (provider charges)" : "Echo (no model call)";
      if (field.key === "template") return option === "bucket" ? "Private encrypted bucket (retain data)" : option === "identity-pool" ? "Cognito identity pool (authenticated only)" : "SQS queue";
      if (field.key === "deploy") return option === "inherit" ? "Inherit · consuming agents" : option === "both" && webSocketCondition ? "Use $connect condition" : deploymentSettingLabel(option, model.deployChoices?.[entry.resourceKind === "tool" ? "tool" : entry.form.category === "webSocket" ? "webSocket" : entry.form.category === "event" ? "event" : "http"]?.[option]);
      if (field.key === "scope") return ({ both: "Dev + Prod", dev: "Development", prod: "Production" } as Record<string, string>)[option] ?? option;
      if (field.key === "category") return ({ event: "Event Lambda", http: "HTTP Lambda", webSocket: "WebSocket Lambda" } as Record<string, string>)[option] ?? option;
      if (field.key === "vpc") { const network = model.networks?.find(network => network.id === option); return network?.name ? `${network.name} (${network.id})` : option || "None"; }
      return option || "None";
    };
    const endpoints = entry.resourceKind === "vpc" && field.key === "endpoints";
    const tagField = field.key === "tags";
    return <div className={cx("flex min-w-0 flex-col gap-1 [&>label]:text-label [&>label]:font-medium [&>input]:w-full [&>select]:w-full [&_p]:m-0", field.type === "boolean" ? "grid grid-cols-[minmax(0,1fr)_auto] content-start items-center gap-x-3 [&>[data-slot=creation-field-control]]:contents [&_[role=switch]]:col-start-2 [&_[role=switch]]:row-start-1 [&_p]:col-span-full" : "", endpoints ? "col-span-full" : "", tagField || field.key === "description" || field.type === "list" ? "col-span-full" : "")} key={field.key}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) touch(field.key); }} data-slot="creation-field" data-creation-field data-wide={tagField || field.key === "description" || field.type === "list"}>
      {tagField ? <span id={`${id}-label`} className={"text-label font-medium"} data-slot="creation-field-label">{field.label}</span> : <label htmlFor={id}>{field.label}</label>}
      <div className={"grid min-w-0 gap-2"} role={tagField ? "group" : undefined} aria-labelledby={tagField ? `${id}-label` : undefined} aria-describedby={tagField ? describedBy : undefined} data-slot="creation-field-control">
      {tagField ? <TagRows value={JSON.parse(String(value ?? "{}")) as Record<string, string>} disabled={disabled} onChange={(tags, error) => { setTagError(error); draft.setCreation(entry.resourceKind, { ...entry.form, tags: JSON.stringify(tags) }, error); }} />
        : endpoints ? <InterfaceEndpointPicker id={id} services={model.interfaceEndpointServices} selected={String(value ?? "").split(",").map(name => name.trim()).filter(Boolean)}
        onChange={services => update(services.join(", "))} disabled={disabled} invalid={!!error} describedBy={describedBy} />
        : field.type === "boolean" ? <InspectorSwitch id={id} label={field.label} checked={value === true} onChange={update} disabled={disabled} invalid={!!error} describedBy={describedBy} />
        : options ? <Select id={id} value={String(value)} onChange={(event) => update(event.target.value)} disabled={disabled} aria-invalid={!!error} aria-describedby={describedBy}>
          {options.map((option) => <option key={option} value={option} disabled={field.key === "deploy" && !!(webSocketCondition || webSocketConditionProblem) && option !== "none" && (option !== "both" || !!webSocketConditionProblem)}>{optionLabel(option)}</option>)}
        </Select>
          : <TextInput id={id} type={field.type === "number" ? "number" : "text"} value={String(value)} onChange={(event) => update(field.type === "number" ? Number(event.target.value) : event.target.value)} disabled={disabled} aria-invalid={!!error} aria-describedby={describedBy} autoComplete="off" spellCheck={false} />}
      {remainingOptions ? <Select aria-label={`Add ${field.key === "steps" ? "workflow step" : "agent tool"}`} disabled={disabled || !remainingOptions.length} value="" onChange={(event) => {
        if (event.target.value) update([String(value), event.target.value].filter(Boolean).join(", "));
      }}><option value="">{remainingOptions.length ? `Select an existing ${field.key === "steps" ? "target" : "tool"}…` : `No more ${field.key === "steps" ? "targets" : "tools"} available`}</option>{remainingOptions.map((option) => <option key={option} value={option}>{option}</option>)}</Select> : null}
      {help ? <p id={`${id}-help`} className={"text-caption text-graphite"}>{help}</p> : null}
      {error ? <p id={`${id}-error`} className={"text-refuse wrap-anywhere text-caption"} role="status">{error}</p> : null}
      </div>
    </div>;
  };
  const implementationDirectory = String(entry.form.directory || defaultImplementationDirectory(entry.resourceKind, String(entry.form.id || "<identifier>"), String(entry.form.category ?? "event")) || "");
  const starterFiles = entry.resourceKind === "agent" ? ["index.ts", "contract.ts", "package.json", "tsconfig.json"] : entry.resourceKind === "tool" ? ["index.ts", "contract.ts"] : entry.resourceKind === "service" ? ["index.mjs", "Dockerfile", "package.json"] : entry.resourceKind === "task" ? ["index.mjs", "Dockerfile"] : ["index.ts"];
  return <dialog ref={dialog} className={cx(dialogClasses({ size: "creation" }), " [&_details>summary]:cursor-pointer [&_details>summary]:py-2")} aria-labelledby={`${prefix}-title`} onCancel={(event) => { event.preventDefault(); back(); }} data-slot="creation-wizard">
    <header className={dialogHeaderClasses}><p className={"text-caption text-graphite"}>Add to application · Configure → Review → Apply</p><h2 id={`${prefix}-title`} className={dialogTitleClasses}>{catalogInput ? "Create input parameter or secret" : entry.resourceKind === "vpc" ? "Create VPC" : `Create ${creator.label.toLowerCase()}`}</h2></header>
    <div className={dialogBodyClasses} aria-busy={!!draftState.busy}>
      <p>{creator.help}</p>
      {catalogInput && entry.form.group ? <p className={"text-caption text-graphite"}>Adds to the input group <code>resources.{String(entry.form.group)}</code>. Change the catalog group under Advanced settings.</p> : null}
      {implementationDirectory && !entry.form.existingTarget ? <details data-slot="implementation-preview"><summary>Implementation files</summary><p className={"text-caption text-graphite"}>{entry.resourceKind === "agent" ? "Repository root" : "cdk-app"}: <code>{implementationDirectory}</code>. {entry.form.implementation === "existing" ? "Existing files are validated and preserved." : "New starter files join the reviewed source patch."} The declared construct identity is resolved during review; deployment is separate.</p>{entry.form.implementation !== "existing" ? <ul>{starterFiles.map(file => <li key={file}><code>{file}</code></li>)}</ul> : null}</details> : null}
      <fieldset className={"m-0 min-w-0 border-0 p-0 [&>details]:mt-4 [&>details[open]>div]:pt-2"} disabled={disabled} aria-label={`${catalogInput ? "Input parameter or secret" : creator.label} settings`} data-slot="creation-form-fields">
      <div className={"grid grid-cols-2 gap-4 m-0 vp-560:grid-cols-[1fr]"} data-slot="creation-fields">{catalogInput ? <div className={"flex min-w-0 flex-col gap-1 [&>label]:text-label [&>label]:font-medium [&>input]:w-full [&>select]:w-full [&_p]:m-0 grid grid-cols-[minmax(0,1fr)_auto] content-start items-center gap-x-3 [&>[data-slot=creation-field-control]]:contents [&_[role=switch]]:col-start-2 [&_[role=switch]]:row-start-1 [&_p]:col-span-full col-span-full"} data-slot="creation-field" data-creation-field data-wide="true">
        <label htmlFor={`${prefix}-secret`}>Secret</label>
        <div className={"grid min-w-0 gap-2"} data-slot="creation-field-control"><InspectorSwitch id={`${prefix}-secret`} label="Secret" checked={entry.resourceKind === "secret"} disabled={disabled} describedBy={`${prefix}-secret-help`} onChange={secret => {
          const kind = secret ? "secret" : "input";
          const form = Object.fromEntries(CREATORS[kind].fields.map(field => [field.key, entry.form[field.key] ?? creationDefaults(kind)[field.key]!])) as Record<string, string | number | boolean>;
          if (!secret) Object.assign(form, entry.inputSettings);
          const consumer = model.targets.find(target => target.ref === form.consumer);
          if (consumer && consumer.kind !== "service" && consumer.kind !== "task") {
            const automatic = String(form.envName) + (entry.resourceKind === "secret" ? "_SECRET_ARN" : "");
            if (form.consumerVariable === automatic) form.consumerVariable = String(form.envName) + (secret ? "_SECRET_ARN" : "");
          }
          draft.setCreation(kind, form, tagError);
        }} /><p id={`${prefix}-secret-help`} className={"text-caption text-graphite"}>Off creates a string input parameter. On creates a secret whose value is authored separately in a protected environment file.</p></div>
      </div> : null}{fields.filter((field) => !field.advanced).map(render)}</div>
      {fields.some((field) => field.advanced) ? <details><summary>Advanced settings</summary><div className={"grid grid-cols-2 gap-4 m-0 vp-560:grid-cols-[1fr]"} data-slot="creation-fields">{fields.filter((field) => field.advanced).map(render)}</div></details> : null}
      </fieldset>
      {live.evaluating ? <p className={"text-caption text-graphite"} role="status">Refreshing configuration… Your form is preserved.</p> : null}
      {draft.conflict ? <div className={"text-refuse wrap-anywhere"} role="alert"><p>Source changed while you were configuring this resource. Your form is preserved. Review against the latest source to check the exact updated proposal.</p><button className={buttonClasses({ variant: "quiet" })} disabled={!!draftState.busy} onClick={() => draft.reviewAgainstLatest()}>Review against latest source</button></div> : null}
      {draftState.error ? <p className={"text-refuse wrap-anywhere"} role="alert">{draftState.error}</p> : null}
      <p className={"text-caption text-graphite"}>Review shows every proposed file before anything is written. Apply saves source; deployment is a separate action.</p>
    </div>
    <footer className={dialogFooterClasses}><button className={buttonClasses({ variant: "quiet" })} disabled={!!draftState.busy} onClick={back}>Back to resource types</button><button className={buttonClasses({ variant: "quiet" })} disabled={!!draftState.busy} onClick={() => draft.discard()}>Cancel creation</button><button className={buttonClasses({ variant: "primary" })} disabled={!!problem || !!tagError || draft.invalid || disabled} onClick={() => void draft.review()} data-variant="primary">Review generated changes</button></footer>
  </dialog>;
}
