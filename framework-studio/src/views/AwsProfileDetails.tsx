import { useId, type ReactNode } from "react";
import type {
  AwsConnectionObservation,
  AwsProfileCatalog,
  AwsProfileDescriptor,
} from "../../shared/aws-connections";
import type { AwsEditableFields } from "../../shared/aws-connection-management";
import type { Mode } from "../../shared/model";
import type { ModeProfiles } from "../aws-profile-selection";
import {
  connectionStateLabels,
  effectiveProfileKind,
  profileMethodLabels,
} from "../aws-profile-queries";
import {
  environmentCardClasses,
  inspectorFieldLabelClasses,
  inspectorHeaderClasses,
  inspectorNoteClasses,
  inspectorStackedFieldClasses,
  inspectorTitleClasses,
} from "../inspector-ui";
import { Button } from "../ui/Button";
import { cx } from "../ui/classes";
import { Select } from "../ui/FormControls";
import { Notice } from "../ui/Surface";
import { ProfileFields } from "./AwsProfileForms";
import { CopyCode } from "./CopyCode";
import { EntityIcon } from "./EntityIcon";
import { EnvironmentName, InspectorKind, InspectorSection } from "./InspectorUI";

const MODES = ["dev", "prod"] as const;
const usage = {
  both: { label: "Dev + Prod", modes: ["dev", "prod"] },
  dev: { label: "Dev only", modes: ["dev"] },
  prod: { label: "Prod only", modes: ["prod"] },
  none: { label: "Not used", modes: [] },
} as const satisfies Record<string, { label: string; modes: readonly Mode[] }>;
const regionSources = { environment: "from environment", explicit: "explicit" } as const;

function profileChain(
  profile: AwsProfileDescriptor,
  catalog: AwsProfileCatalog,
): AwsProfileDescriptor[] {
  const result: AwsProfileDescriptor[] = [],
    seen = new Set<string>();
  let current: AwsProfileDescriptor | undefined = profile;
  while (current && !seen.has(current.name)) {
    result.push(current);
    seen.add(current.name);
    current = current.sourceProfile
      ? catalog.profiles.find((candidate) => candidate.name === current!.sourceProfile)
      : undefined;
  }
  return result;
}
function terminalIdentityCommand(profile: string): string {
  const windows = /Windows/i.test(navigator.userAgent);
  const quoted = windows
    ? "'" + profile.replaceAll("'", "''") + "'"
    : "'" + profile.replaceAll("'", "'\\''") + "'";
  return `aws sts get-caller-identity --profile ${quoted}`;
}

/** A dot and caption, as local values show theirs: the words carry the state, the colour repeats it. */
export function ProfileStatusLine({
  tone,
  role,
  title,
  children,
}: {
  readonly tone: "accept" | "refuse" | "local" | "neutral";
  readonly role?: "status" | "alert";
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <p
      role={role}
      title={title}
      className={cx(
        "m-0 flex items-center gap-1.5 text-caption",
        tone === "accept"
          ? "text-accept"
          : tone === "refuse"
            ? "text-refuse"
            : tone === "local"
              ? "text-local"
              : "text-graphite",
      )}
    >
      <span className="size-1.5 flex-none rounded-full bg-current" aria-hidden />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  );
}

function stateTone(state: AwsConnectionObservation["state"]) {
  return state === "connected"
    ? "accept"
    : state === "checking"
      ? "local"
      : state === "unchecked"
        ? "neutral"
        : "refuse";
}

function ConnectionIdentity({ observation }: { readonly observation?: AwsConnectionObservation }) {
  const identity = observation?.identity ?? observation?.lastKnownIdentity;
  const state = observation?.state ?? "unchecked";
  const checked = observation?.checkedAt ? new Date(observation.checkedAt) : undefined;
  // The profile's own region is already its configuration field; only an override is news here.
  const regionSource =
    observation?.region.value && observation.region.source !== "profile"
      ? regionSources[observation.region.source as keyof typeof regionSources]
      : undefined;
  return (
    <div className="grid min-w-0 gap-3" role="status">
      <ProfileStatusLine tone={stateTone(state)} title={checked?.toLocaleString()}>
        {connectionStateLabels[state]}
        {checked ? ` · ${checked.toLocaleTimeString()}` : ""}
      </ProfileStatusLine>
      {observation?.problem ? (
        <p className="m-0 text-caption text-refuse wrap-anywhere">{observation.problem.message}</p>
      ) : null}
      {identity ? (
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-caption">
          <dt className="text-graphite">Principal</dt>
          <dd className="m-0 grid min-w-0 gap-0.5">
            <span className="wrap-anywhere">
              {identity.summary}
              {!observation?.identity ? " · last verified (stale)" : ""}
            </span>
            <code className="text-graphite wrap-anywhere">{identity.arn}</code>
          </dd>
          <dt className="text-graphite">Account</dt>
          <dd className="m-0 min-w-0">
            <code>{identity.account}</code>
          </dd>
          {regionSource ? (
            <>
              <dt className="text-graphite">Region</dt>
              <dd className="m-0 min-w-0 wrap-anywhere">
                <code>{observation!.region.value}</code> · {regionSource}
              </dd>
            </>
          ) : null}
          {observation?.credentialExpiration ? (
            <>
              <dt className="text-graphite">Expires</dt>
              <dd className="m-0 grid min-w-0 gap-0.5">
                <span>{new Date(observation.credentialExpiration.at).toLocaleString()}</span>
                <span className="text-graphite">
                  Reported by the native provider. The upstream session may refresh them.
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

export function AwsProfileDetails({
  profile,
  catalog,
  observation,
  associations,
  pending,
  onTest,
  onAuthenticate,
  onLogout,
  onUse,
  onSelectProfile,
  onReview,
}: {
  readonly profile: AwsProfileDescriptor;
  readonly catalog: AwsProfileCatalog;
  readonly observation?: AwsConnectionObservation;
  readonly associations: ModeProfiles;
  readonly pending: boolean;
  readonly onTest: () => void;
  readonly onAuthenticate: () => void;
  readonly onLogout: () => void;
  readonly onUse: (modes: readonly Mode[]) => void;
  readonly onSelectProfile: (name: string) => void;
  readonly onReview: (fields: AwsEditableFields) => void;
}) {
  const chain = profileChain(profile, catalog),
    root = chain.at(-1);
  // The method the AWS CLI resolved this profile through; an unused session is not offered.
  const kind = effectiveProfileKind(profile, observation);
  const sessionInUse = root !== profile || kind === profile.kind;
  const nativeAuthentication = chain.some((item, index) =>
    ["login", "sso"].includes(index ? item.kind : kind),
  );
  const state = observation?.state ?? "unchecked";
  const terminal =
    profile.hasMfa || profile.kind === "process" || observation?.problem?.action === "terminal";
  const source = profile.sourceProfile
    ? catalog.profiles.find((item) => item.name === profile.sourceProfile)
    : undefined;
  const lines = [
    profile.sourceProfile
      ? {
          label: "Source profile",
          value: source ? (
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-graphite underline decoration-rule-strong underline-offset-[3px] hover:text-ink hover:decoration-ink disabled:cursor-not-allowed"
              disabled={pending}
              onClick={() => onSelectProfile(source.name)}
            >
              <code>{source.name}</code>
            </button>
          ) : (
            <code>{profile.sourceProfile}</code>
          ),
        }
      : undefined,
    !sessionInUse
      ? undefined
      : root?.ssoSession
      ? { label: "SSO session", value: <code>{root.ssoSession}</code> }
      : root?.loginSession
        ? {
            label: "Console session",
            value: <code>{root.loginSession}</code>,
          }
        : undefined,
    profile.credentialSource
      ? {
          label: "Credential source",
          value: <code>{profile.credentialSource}</code>,
        }
      : undefined,
  ].filter((line) => line !== undefined);
  // The CLI's precedence among several configured methods is shown by the header's method label,
  // which follows the verified identity; a backend still reporting it as a warning is not repeated.
  const shown = profile.diagnostics.filter((item) => item.code !== "multiple-mechanisms");
  const issues = [
    ...shown.filter((item) => item.severity === "error"),
    ...shown.filter((item) => item.severity === "warning"),
  ];
  const usageId = useId();
  const selected = { dev: associations.dev === profile.name, prod: associations.prod === profile.name };
  const used = selected.dev ? (selected.prod ? "both" : "dev") : selected.prod ? "prod" : "none";
  const section = profile.provenance.config
    ? profile.name === "default"
      ? "[default]"
      : `[profile ${profile.name}]`
    : `[${profile.name}]`;
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind
          environments={{
            availability: selected,
            label: "Declaration modes",
            descriptions: { dev: "uses this profile", prod: "uses this profile" },
            unavailableDescription: "uses another profile or none",
          }}
        >
          {profileMethodLabels[kind]}
        </InspectorKind>
        <h3 tabIndex={-1} className={inspectorTitleClasses}>
          <span className="float-left mt-px mr-2 inline-flex size-6">
            <EntityIcon size={24} icon={kind === "sso" ? "identityCenter" : "iam"} />
          </span>
          {profile.name}
        </h3>
        <code className="block text-graphite text-meta wrap-anywhere" data-slot="ref">
          {section}
        </code>
        {lines.length ? (
          <dl className="mt-2 mb-0 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-meta text-graphite">
            {lines.map((line) => (
              <div key={line.label} className="contents">
                <dt>{line.label}</dt>
                <dd className="m-0 flex min-h-5.5 min-w-0 items-center text-caption wrap-anywhere">
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {issues.length ? (
          // The header closes with its issues, as IssueNotice does: errors are alerts; warnings are notes.
          <div className="mt-3 grid gap-2" data-slot="issues">
            {issues.map((issue, index) => (
              <Notice
                key={index}
                tone={issue.severity}
                role={issue.severity === "error" ? "alert" : "note"}
              >
                <p className="m-0 text-caption wrap-anywhere">{issue.message}</p>
              </Notice>
            ))}
          </div>
        ) : null}
      </header>
      <InspectorSection
        title="Declaration modes"
        contentClassName="grid gap-4"
        data-slot="aws-profile-modes"
      >
        <div className="m-0 grid grid-cols-2 gap-2" aria-live="polite" aria-atomic="true">
          {MODES.map((mode) => (
            <div
              key={mode}
              className={environmentCardClasses({ mode, active: selected[mode] })}
              data-mode={mode}
            >
              <EnvironmentName mode={mode} active={selected[mode]} />
              <strong
                className={cx("text-label font-medium", selected[mode] ? "text-ink" : "text-graphite")}
              >
                {selected[mode] ? "Uses this profile" : "Not selected"}
              </strong>
              {!selected[mode] && associations[mode] ? (
                <span className="text-meta text-graphite wrap-anywhere">
                  Uses <code>{associations[mode]}</code>
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <div className={inspectorStackedFieldClasses} data-slot="field">
          <label htmlFor={usageId} className={inspectorFieldLabelClasses()}>
            Use for
          </label>
          <Select
            id={usageId}
            controlSize="panel"
            className="w-full"
            disabled={pending}
            value={used}
            onChange={(event) => onUse(usage[event.target.value as keyof typeof usage].modes)}
          >
            {Object.entries(usage).map(([value, option]) => (
              <option key={value} value={value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </InspectorSection>
      <InspectorSection
        title="Identity"
        description="Confirms authentication only. Each AWS operation checks its own permissions."
      >
        <div className="grid min-w-0 gap-3">
          <ConnectionIdentity observation={observation} />
          {terminal ? (
            <div className="grid min-w-0 gap-2">
              <p className={inspectorNoteClasses}>
                Complete any MFA or provider prompt in your terminal, then test this connection
                again.
              </p>
              <CopyCode code={terminalIdentityCommand(profile.name)} label="identity check command" />
            </div>
          ) : null}
          {/* One slot: Test becomes Reconnect when a session-backed profile needs sign-in;
              sign-out appears only while a verified session exists to end. */}
          <div className="flex flex-wrap justify-end gap-2" data-slot="aws-profile-identity-actions">
            {nativeAuthentication && state === "connected" ? (
              <Button variant="quiet" disabled={pending} onClick={onLogout}>
                Review sign-out
              </Button>
            ) : null}
            {nativeAuthentication && state === "needs-auth" ? (
              <Button variant="primary" disabled={pending} onClick={onAuthenticate}>
                Reconnect
              </Button>
            ) : (
              <Button variant="quiet" disabled={pending} onClick={onTest}>
                Test connection
              </Button>
            )}
          </div>
        </div>
      </InspectorSection>
      {/* The panel's last section: the status line's rule already closes it, so it draws none. */}
      <InspectorSection title="Configuration" embedded className="px-5 py-4">
        <ProfileFields
          key={`${profile.name}:${catalog.revision}`}
          profile={profile}
          profiles={catalog.profiles}
          sessions={catalog.sessions}
          busy={pending}
          onReview={onReview}
        />
      </InspectorSection>
    </>
  );
}
