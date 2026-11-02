import { useId, useState } from "react";
import type {
  AwsProfileCatalog,
  AwsProfileDescriptor,
  AwsSsoSessionDescriptor,
} from "../../shared/aws-connections";
import type { AwsEditableFields, AwsCliCapabilities } from "../../shared/aws-connection-management";
import type { AuthenticationRequest } from "../aws-connections-api";
import { Button } from "../ui/Button";
import { Select, TextInput } from "../ui/FormControls";

const labelClass = "grid min-w-0 gap-1 text-label";
const helpClass = "m-0 text-caption text-graphite";

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
  const changed = Object.entries(fields).some(
    ([key, value]) => value !== (original[key as keyof typeof original] ?? ""),
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onReview(fields);
      }}
    >
      <h4 className="m-0 text-body font-semibold">Configuration</h4>
      {!profile.editable ? (
        <p className={helpClass}>
          {profile.provenance.readOnlyReason ??
            "This profile is managed outside Studio. Inspect and authenticate here; edit it in your native AWS configuration."}
        </p>
      ) : null}
      <fieldset
        disabled={busy || !profile.editable}
        className="m-0 grid min-w-0 gap-3 border-0 p-0"
      >
        <label className={labelClass}>
          Default AWS region
          <TextInput
            value={fields.region ?? original.region ?? ""}
            onChange={(event) => change("region", event.target.value)}
            placeholder="For example, us-east-1"
          />
        </label>
        {profile.kind === "assume-role" ? (
          <>
            <label className={labelClass}>
              Role ARN
              <TextInput
                value={fields.role_arn ?? original.role_arn ?? ""}
                onChange={(event) => change("role_arn", event.target.value)}
              />
            </label>
            {!profile.credentialSource ? (
              <label className={labelClass}>
                Source profile
                <Select
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
              </label>
            ) : (
              <p className={helpClass}>
                Credential source: {profile.credentialSource}. This provider relationship is managed
                outside Studio.
              </p>
            )}
            <details className="grid gap-3">
              <summary className="cursor-pointer text-label">Advanced role settings</summary>
              <div className="grid gap-3 pt-3">
                <label className={labelClass}>
                  Role session name
                  <TextInput
                    value={fields.role_session_name ?? original.role_session_name ?? ""}
                    onChange={(event) => change("role_session_name", event.target.value)}
                  />
                </label>
                <label className={labelClass}>
                  Session duration in seconds
                  <TextInput
                    inputMode="numeric"
                    value={fields.duration_seconds ?? original.duration_seconds ?? ""}
                    onChange={(event) => change("duration_seconds", event.target.value)}
                  />
                </label>
                <label className={labelClass}>
                  MFA device ARN
                  <TextInput
                    value={fields.mfa_serial ?? original.mfa_serial ?? ""}
                    onChange={(event) => change("mfa_serial", event.target.value)}
                  />
                </label>
                <p className={helpClass}>
                  Studio reuses native role credentials. If MFA interaction is needed, authenticate
                  in your terminal.
                </p>
              </div>
            </details>
          </>
        ) : null}
        {profile.ssoSession ? (
          <>
            <label className={labelClass}>
              Identity Center session
              <Select
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
            </label>
            <label className={labelClass}>
              AWS account ID
              <TextInput
                value={fields.sso_account_id ?? original.sso_account_id ?? ""}
                onChange={(event) => change("sso_account_id", event.target.value)}
              />
            </label>
            <label className={labelClass}>
              Permission set
              <TextInput
                value={fields.sso_role_name ?? original.sso_role_name ?? ""}
                onChange={(event) => change("sso_role_name", event.target.value)}
              />
            </label>
          </>
        ) : null}
        <Button type="submit" variant="quiet" className="justify-self-start" disabled={!changed}>
          Review configuration changes
        </Button>
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
  const [method, setMethod] = useState("login");
  const [name, setName] = useState(fixedName ?? "");
  const [region, setRegion] = useState("");
  const [session, setSession] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [ssoRegion, setSsoRegion] = useState("");
  const [source, setSource] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const nameHelp = useId();
  const [nameTouched, setNameTouched] = useState(false);
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
      className="grid gap-4"
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
      <div className="grid gap-1">
        <h3 tabIndex={-1} className="m-0 text-body font-semibold">
          {fixedName === "default" ? "Configure default profile" : "Add AWS profile"}
        </h3>
        <p className={helpClass}>
          Connect using your existing AWS account access. Temporary credentials are recommended.
        </p>
      </div>
      <fieldset disabled={busy} className="m-0 grid min-w-0 gap-4 border-0 p-0">
        <label className={labelClass}>
          How do you connect to AWS?
          <Select value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="login">Sign in with AWS Console</option>
            <option value="sso">IAM Identity Center</option>
            <option value="role">Assume an IAM role</option>
            <option value="static">Access keys</option>
            <option value="external">External credential provider</option>
          </Select>
        </label>
        {method === "login" ? (
          <p className={helpClass}>
            Use your Console IAM or federated sign-in. Your browser handles authentication; AWS CLI
            manages temporary credentials.
          </p>
        ) : null}
        {method === "sso" ? (
          <p className={helpClass}>
            For organization access through an AWS access portal. After sign-in, choose an assigned
            account and permission set.
          </p>
        ) : null}
        {!nativeOnly ? (
          <>
            <label className={labelClass}>
              Profile name
              <TextInput
                required
                readOnly={!!fixedName}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => setNameTouched(true)}
                aria-describedby={fixedName ? undefined : nameHelp}
                aria-invalid={collision || (nameTouched && !validName) || undefined}
                placeholder="For example, team-developer"
              />
            </label>
            {!fixedName ? (
              <p id={nameHelp} className={helpClass}>
                Use letters, numbers, dots, underscores, +, @ or hyphens, starting with a letter,
                number or underscore.
              </p>
            ) : null}
            {collision ? (
              <p className="m-0 text-caption text-refuse" role="alert">
                A profile with this name already exists. Choose a new name.
              </p>
            ) : null}
            <label className={labelClass}>
              Default AWS region
              <TextInput
                required={method === "login"}
                value={region}
                onChange={(event) => setRegion(event.target.value)}
                placeholder="For example, us-east-1"
              />
            </label>
          </>
        ) : null}
        {method === "sso" ? (
          <>
            <label className={labelClass}>
              Identity Center session
              <Select
                value={catalog.sessions.some((item) => item.name === session) ? session : ""}
                onChange={(event) => {
                  const chosen = catalog.sessions.find((item) => item.name === event.target.value);
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
            </label>
            <label className={labelClass}>
              Session name
              <TextInput
                required
                value={session}
                onChange={(event) => setSession(event.target.value)}
              />
            </label>
            <label className={labelClass}>
              AWS access portal or issuer URL
              <TextInput
                required
                type="url"
                value={startUrl}
                onChange={(event) => setStartUrl(event.target.value)}
                placeholder="https://your-team.awsapps.com/start"
              />
            </label>
            <label className={labelClass}>
              Identity Center region
              <TextInput
                required
                value={ssoRegion}
                onChange={(event) => setSsoRegion(event.target.value)}
              />
            </label>
            <p className={helpClass}>
              Your organization’s Identity Center region can differ from the AWS region where you
              run operations.
            </p>
          </>
        ) : null}
        {method === "role" ? (
          <>
            <label className={labelClass}>
              Source profile
              <Select required value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="">Choose source profile…</option>
                {catalog.profiles.map((item) => (
                  <option key={item.name}>{item.name}</option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              Role ARN
              <TextInput
                required
                value={roleArn}
                onChange={(event) => setRoleArn(event.target.value)}
                placeholder="arn:aws:iam::123456789012:role/Developer"
              />
            </label>
            <p className={helpClass}>
              The source identity must be allowed to assume this role, and the role must trust it.
              Saving configuration grants no AWS permissions.
            </p>
          </>
        ) : null}
        {nativeOnly ? (
          <div className="grid gap-2 rounded-md border border-rule bg-wash p-3">
            <p className={helpClass}>
              {method === "static"
                ? "Configure access keys in your terminal using the native AWS CLI. Credentials never pass through Studio’s browser."
                : "Configure your provider using its own tooling. Studio discovers and uses the resulting named profile without exposing its command or secrets."}
            </p>
            {method === "static" ? (
              <code className="text-caption wrap-anywhere">
                aws configure --profile {fixedName ?? "your-profile-name"}
              </code>
            ) : null}
            <p className={helpClass}>Then refresh the profile list.</p>
          </div>
        ) : null}
        {!supported ? (
          <p className="m-0 text-caption text-refuse" role="alert">
            Update AWS CLI to use this authentication method. Console login requires 2.32.0; modern
            Identity Center sessions require 2.9.0.
          </p>
        ) : null}
        {!nativeOnly ? (
          <Button
            type="submit"
            variant="primary"
            disabled={!valid || !supported}
            className="justify-self-start"
          >
            {method === "role" ? "Review new profile" : "Continue to sign in"}
          </Button>
        ) : null}
      </fieldset>
    </form>
  );
}
