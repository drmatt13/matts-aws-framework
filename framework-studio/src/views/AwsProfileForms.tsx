import { useId, useState, type ReactNode } from "react";
import type {
  AwsProfileCatalog,
  AwsProfileDescriptor,
  AwsSsoSessionDescriptor,
} from "../../shared/aws-connections";
import type { AwsEditableFields, AwsCliCapabilities } from "../../shared/aws-connection-management";
import type { AuthenticationRequest } from "../aws-connections-api";
import {
  inspectorFieldClasses,
  inspectorFieldLabelClasses,
  inspectorHeaderClasses,
  inspectorHelpClasses,
  inspectorLockedClasses,
  inspectorNoteClasses,
  inspectorTitleClasses,
} from "../inspector-ui";
import { Button } from "../ui/Button";
import { cx } from "../ui/classes";
import { Select, TextInput } from "../ui/FormControls";
import { CopyCode } from "./CopyCode";
import { InspectorDisclosure, InspectorKind } from "./InspectorUI";

const methodHelp = {
  login:
    "Use your Console IAM or federated sign-in. Your browser handles authentication; AWS CLI manages temporary credentials.",
  sso: "For organization access through an AWS access portal. After sign-in, choose an assigned account and permission set.",
  role: "The source identity must be allowed to assume this role, and the role must trust it. Saving configuration grants no AWS permissions.",
  static:
    "Configure access keys in your terminal using the native AWS CLI. Credentials never pass through Studio’s browser.",
  external:
    "Configure your provider using its own tooling. Studio discovers and uses the resulting named profile without exposing its command or secrets.",
} as const;

/** One inspector field row: label → control → support on one left edge, ruled from its neighbours. */
function ProfileField({
  label,
  modified = false,
  help,
  children,
}: {
  readonly label: string;
  readonly modified?: boolean;
  readonly help?: ReactNode;
  readonly children: (control: { readonly id: string; readonly "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={inspectorFieldClasses} data-slot="field">
      <label htmlFor={id} className={inspectorFieldLabelClasses()}>
        {label}
        {/* The inspector's modified dot, kept out of the control's accessible name. */}
        {modified ? (
          <span aria-hidden className="text-dev">
            {" •"}
          </span>
        ) : null}
      </label>
      {children({ id, ...(help ? { "aria-describedby": `${id}-help` } : {}) })}
      {help ? (
        <p id={`${id}-help`} className={cx("m-0", inspectorHelpClasses)}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

export function ProfileFields({
  profile,
  profiles,
  sessions,
  busy,
  onReview,
}: {
  readonly profile: AwsProfileDescriptor;
  readonly profiles: readonly AwsProfileDescriptor[];
  readonly sessions: readonly AwsSsoSessionDescriptor[];
  readonly busy: boolean;
  readonly onReview: (fields: AwsEditableFields) => void;
}) {
  const original = profile.configuration;
  const [fields, setFields] = useState<AwsEditableFields>({});
  const change = (field: keyof AwsEditableFields, value: string) =>
    setFields((current) => ({ ...current, [field]: value }));
  const modified = (field: keyof AwsEditableFields) =>
    fields[field] !== undefined && fields[field] !== (original[field] ?? "");
  const changed = (Object.keys(fields) as (keyof AwsEditableFields)[]).some(modified);
  return (
    <form
      className="grid min-w-0 gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onReview(fields);
      }}
    >
      {!profile.editable ? (
        <p className={cx("m-0", inspectorLockedClasses)}>
          {profile.provenance.readOnlyReason ??
            "This profile is managed outside Studio. Inspect and authenticate here; edit it in your native AWS configuration."}
        </p>
      ) : null}
      <fieldset disabled={busy || !profile.editable} className="m-0 grid min-w-0 border-0 p-0">
        <ProfileField label="Default AWS region" modified={modified("region")}>
          {(control) => (
            <TextInput
              {...control}
              controlSize="panel"
              value={fields.region ?? original.region ?? ""}
              onChange={(event) => change("region", event.target.value)}
              placeholder="For example, us-east-1"
            />
          )}
        </ProfileField>
        {profile.kind === "assume-role" ? (
          <>
            <ProfileField label="Role ARN" modified={modified("role_arn")}>
              {(control) => (
                <TextInput
                  {...control}
                  controlSize="panel"
                  value={fields.role_arn ?? original.role_arn ?? ""}
                  onChange={(event) => change("role_arn", event.target.value)}
                />
              )}
            </ProfileField>
            {!profile.credentialSource ? (
              <ProfileField label="Source profile" modified={modified("source_profile")}>
                {(control) => (
                  <Select
                    {...control}
                    controlSize="panel"
                    value={fields.source_profile ?? original.source_profile ?? ""}
                    onChange={(event) => change("source_profile", event.target.value)}
                  >
                    <option value="">Choose source profile…</option>
                    {profiles
                      .filter((item) => item.name !== profile.name)
                      .map((item) => (
                        <option key={item.name}>{item.name}</option>
                      ))}
                  </Select>
                )}
              </ProfileField>
            ) : (
              <div className={inspectorFieldClasses} data-slot="field">
                <span className={inspectorFieldLabelClasses()}>Credential source</span>
                <code className="min-w-0 text-caption wrap-anywhere">{profile.credentialSource}</code>
                <p className={cx("m-0", inspectorHelpClasses)}>
                  This provider relationship is managed outside Studio.
                </p>
              </div>
            )}
            <InspectorDisclosure
              title="Advanced role settings"
              embedded
              className="border-t border-rule"
              status={
                modified("role_session_name") ||
                modified("duration_seconds") ||
                modified("mfa_serial")
                  ? "modified"
                  : undefined
              }
            >
              <ProfileField label="Role session name" modified={modified("role_session_name")}>
                {(control) => (
                  <TextInput
                    {...control}
                    controlSize="panel"
                    value={fields.role_session_name ?? original.role_session_name ?? ""}
                    onChange={(event) => change("role_session_name", event.target.value)}
                  />
                )}
              </ProfileField>
              <ProfileField label="Session duration in seconds" modified={modified("duration_seconds")}>
                {(control) => (
                  <TextInput
                    {...control}
                    controlSize="panel"
                    inputMode="numeric"
                    value={fields.duration_seconds ?? original.duration_seconds ?? ""}
                    onChange={(event) => change("duration_seconds", event.target.value)}
                  />
                )}
              </ProfileField>
              <ProfileField
                label="MFA device ARN"
                modified={modified("mfa_serial")}
                help="Studio reuses native role credentials. If MFA interaction is needed, authenticate in your terminal."
              >
                {(control) => (
                  <TextInput
                    {...control}
                    controlSize="panel"
                    value={fields.mfa_serial ?? original.mfa_serial ?? ""}
                    onChange={(event) => change("mfa_serial", event.target.value)}
                  />
                )}
              </ProfileField>
            </InspectorDisclosure>
          </>
        ) : null}
        {profile.ssoSession ? (
          <>
            <ProfileField label="Identity Center session" modified={modified("sso_session")}>
              {(control) => (
                <Select
                  {...control}
                  controlSize="panel"
                  value={fields.sso_session ?? original.sso_session ?? profile.ssoSession}
                  onChange={(event) => change("sso_session", event.target.value)}
                >
                  {!sessions.some((session) => session.name === profile.ssoSession) ? (
                    <option value={profile.ssoSession}>{profile.ssoSession}</option>
                  ) : null}
                  {sessions.map((session) => (
                    <option key={session.name}>{session.name}</option>
                  ))}
                </Select>
              )}
            </ProfileField>
            <ProfileField label="AWS account ID" modified={modified("sso_account_id")}>
              {(control) => (
                <TextInput
                  {...control}
                  controlSize="panel"
                  value={fields.sso_account_id ?? original.sso_account_id ?? ""}
                  onChange={(event) => change("sso_account_id", event.target.value)}
                />
              )}
            </ProfileField>
            <ProfileField label="Permission set" modified={modified("sso_role_name")}>
              {(control) => (
                <TextInput
                  {...control}
                  controlSize="panel"
                  value={fields.sso_role_name ?? original.sso_role_name ?? ""}
                  onChange={(event) => change("sso_role_name", event.target.value)}
                />
              )}
            </ProfileField>
          </>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-3">
          {changed ? (
            <Button type="button" variant="quiet" onClick={() => setFields({})}>
              Discard
            </Button>
          ) : null}
          <Button type="submit" variant={changed ? "primary" : "quiet"} disabled={!changed}>
            Review configuration changes
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function AddProfile({
  catalog,
  capabilities,
  fixedName,
  busy,
  onAuthenticate,
  onReview,
}: {
  readonly catalog: AwsProfileCatalog;
  readonly capabilities?: AwsCliCapabilities;
  readonly fixedName?: string;
  readonly busy: boolean;
  readonly onAuthenticate: (request: AuthenticationRequest) => void;
  readonly onReview: (name: string, fields: AwsEditableFields) => void;
}) {
  const [method, setMethod] = useState<keyof typeof methodHelp>("login");
  const [name, setName] = useState(fixedName ?? "");
  const [region, setRegion] = useState("");
  const [session, setSession] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [ssoRegion, setSsoRegion] = useState("");
  const [source, setSource] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const collisionId = useId();
  const collision = catalog.profiles.some((profile) => profile.name === name.trim());
  const validName = /^[\w][\w.@+-]{0,127}$/.test(name.trim());
  const nativeOnly = method === "static" || method === "external";
  const supported =
    method === "login"
      ? capabilities?.consoleLogin !== false
      : method === "sso"
        ? capabilities?.modernSso !== false
        : true;
  const valid =
    validName &&
    !collision &&
    (method !== "login" || !!region.trim()) &&
    (method !== "sso" || (!!session && !!startUrl && !!ssoRegion)) &&
    (method !== "role" || (!!source && !!roleArn));
  return (
    <form
      className="grid min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || nativeOnly) return;
        if (method === "role")
          onReview(name.trim(), {
            ...(region.trim() ? { region: region.trim() } : {}),
            source_profile: source,
            role_arn: roleArn.trim(),
          });
        else
          onAuthenticate({
            method: method as "login" | "sso",
            name: name.trim(),
            region: region.trim(),
            ...(method === "sso" ? { session, startUrl, ssoRegion } : {}),
          });
      }}
    >
      <header className={inspectorHeaderClasses}>
        <InspectorKind>New profile</InspectorKind>
        <h3 tabIndex={-1} className={inspectorTitleClasses}>
          {fixedName === "default" ? "Configure default profile" : "Add AWS profile"}
        </h3>
      </header>
      <fieldset disabled={busy} className="m-0 grid min-w-0 border-0 px-5 py-4">
        <ProfileField label="How do you connect to AWS?" help={methodHelp[method]}>
          {(control) => (
            <Select
              {...control}
              controlSize="panel"
              value={method}
              onChange={(event) => setMethod(event.target.value as keyof typeof methodHelp)}
            >
              <option value="login">Sign in with AWS Console</option>
              <option value="sso">IAM Identity Center</option>
              <option value="role">Assume an IAM role</option>
              <option value="static">Access keys</option>
              <option value="external">External credential provider</option>
            </Select>
          )}
        </ProfileField>
        {!nativeOnly ? (
          <>
            <ProfileField
              label="Profile name"
              help={
                fixedName
                  ? undefined
                  : "Use letters, numbers, dots, underscores, +, @ or hyphens, starting with a letter, number or underscore."
              }
            >
              {(control) => (
                <>
                  <TextInput
                    {...control}
                    aria-describedby={
                      [control["aria-describedby"], collision ? collisionId : undefined]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    controlSize="panel"
                    required
                    readOnly={!!fixedName}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onBlur={() => setNameTouched(true)}
                    aria-invalid={collision || (nameTouched && !validName) || undefined}
                    placeholder="For example, team-developer"
                  />
                  {collision ? (
                    <p id={collisionId} className={cx("m-0", inspectorLockedClasses)} role="alert">
                      A profile with this name already exists. Choose a new name.
                    </p>
                  ) : null}
                </>
              )}
            </ProfileField>
            <ProfileField label="Default AWS region">
              {(control) => (
                <TextInput
                  {...control}
                  controlSize="panel"
                  required={method === "login"}
                  value={region}
                  onChange={(event) => setRegion(event.target.value)}
                  placeholder="For example, us-east-1"
                />
              )}
            </ProfileField>
          </>
        ) : null}
        {method === "sso" ? (
          <>
            <ProfileField label="Identity Center session">
              {(control) => (
                <Select
                  {...control}
                  controlSize="panel"
                  value={catalog.sessions.some((item) => item.name === session) ? session : ""}
                  onChange={(event) => {
                    const chosen = catalog.sessions.find(
                      (item) => item.name === event.target.value,
                    );
                    setSession(chosen?.name ?? "");
                    setStartUrl(chosen?.startUrl ?? "");
                    setSsoRegion(chosen?.region ?? "");
                  }}
                >
                  <option value="">Create a new session…</option>
                  {catalog.sessions.map((item) => (
                    <option key={item.name}>{item.name}</option>
                  ))}
                </Select>
              )}
            </ProfileField>
            <ProfileField label="Session name">
              {(control) => (
                <TextInput
                  {...control}
                  controlSize="panel"
                  required
                  value={session}
                  onChange={(event) => setSession(event.target.value)}
                />
              )}
            </ProfileField>
            <ProfileField label="AWS access portal or issuer URL">
              {(control) => (
                <TextInput
                  {...control}
                  controlSize="panel"
                  required
                  type="url"
                  value={startUrl}
                  onChange={(event) => setStartUrl(event.target.value)}
                  placeholder="https://your-team.awsapps.com/start"
                />
              )}
            </ProfileField>
            <ProfileField
              label="Identity Center region"
              help="Your organization’s Identity Center region can differ from the AWS region where you run operations."
            >
              {(control) => (
                <TextInput
                  {...control}
                  controlSize="panel"
                  required
                  value={ssoRegion}
                  onChange={(event) => setSsoRegion(event.target.value)}
                />
              )}
            </ProfileField>
          </>
        ) : null}
        {method === "role" ? (
          <>
            <ProfileField label="Source profile">
              {(control) => (
                <Select
                  {...control}
                  controlSize="panel"
                  required
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                >
                  <option value="">Choose source profile…</option>
                  {catalog.profiles.map((item) => (
                    <option key={item.name}>{item.name}</option>
                  ))}
                </Select>
              )}
            </ProfileField>
            <ProfileField label="Role ARN">
              {(control) => (
                <TextInput
                  {...control}
                  controlSize="panel"
                  required
                  value={roleArn}
                  onChange={(event) => setRoleArn(event.target.value)}
                  placeholder="arn:aws:iam::123456789012:role/Developer"
                />
              )}
            </ProfileField>
          </>
        ) : null}
        {nativeOnly ? (
          <div className="grid min-w-0 gap-2 border-t border-rule pt-3">
            {method === "static" ? (
              <CopyCode
                code={`aws configure --profile ${fixedName ?? "your-profile-name"}`}
                label="access key setup command"
              />
            ) : null}
            <p className={inspectorNoteClasses}>Then refresh the profile list.</p>
          </div>
        ) : null}
        {!supported ? (
          <p className={cx("mt-3 mb-0", inspectorLockedClasses)} role="alert">
            Update AWS CLI to use this authentication method. Console login requires 2.32.0; modern
            Identity Center sessions require 2.9.0.
          </p>
        ) : null}
        {!nativeOnly ? (
          <div className="flex pt-3">
            <Button type="submit" variant="primary" disabled={!valid || !supported}>
              {method === "role" ? "Review new profile" : "Continue to sign in"}
            </Button>
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}
