import { Check } from "lucide-react";
import type {
  AwsConnectionObservation,
  AwsProfileCatalog,
  AwsProfileDescriptor,
} from "../../shared/aws-connections";
import type { AwsEditableFields } from "../../shared/aws-connection-management";
import type { Mode } from "../../shared/model";
import type { ModeProfiles } from "../aws-profile-selection";
import { connectionStateLabels, profileMethodLabels } from "../aws-profile-queries";
import { Button } from "../ui/Button";
import { cx } from "../ui/classes";
import { ProfileFields } from "./AwsProfileForms";
const note = "m-0 text-caption text-graphite";
const sectionHeading = "m-0 text-body font-semibold";

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

function ConnectionIdentity({ observation }: { readonly observation?: AwsConnectionObservation }) {
  const identity = observation?.identity ?? observation?.lastKnownIdentity;
  return (
    <div className="grid gap-2 rounded-md border border-rule bg-wash p-3" role="status">
      <strong className="text-label">
        {observation ? connectionStateLabels[observation.state] : "Not checked"}
      </strong>
      {observation?.problem ? (
        <p className="m-0 text-caption text-refuse">{observation.problem.message}</p>
      ) : null}
      {identity ? (
        <>
          <span className="text-label wrap-anywhere">
            {identity.summary}
            {!observation?.identity ? " · last verified (stale)" : ""}
          </span>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption">
            <dt>Account</dt>
            <dd className="m-0 font-mono">{identity.account}</dd>
            <dt>Principal</dt>
            <dd className="m-0 font-mono wrap-anywhere">{identity.arn}</dd>
          </dl>
          {identity.principalKind === "root" ? (
            <p className="m-0 text-caption text-refuse">
              This is the AWS account root identity. Use a dedicated workforce or IAM role for
              development.
            </p>
          ) : null}
        </>
      ) : (
        <p className={note}>Test this profile to resolve its actual AWS account and principal.</p>
      )}
      {observation?.checkedAt ? (
        <span className={note}>Checked {new Date(observation.checkedAt).toLocaleString()}</span>
      ) : null}
      {observation?.region.value ? (
        <span className={note}>
          Region: {observation.region.value} · {observation.region.source}
        </span>
      ) : null}
      {observation?.credentialExpiration ? (
        <span className={note}>
          Native provider reports credential expiration:{" "}
          {new Date(observation.credentialExpiration.at).toLocaleString()}. The upstream session may
          refresh them.
        </span>
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
  reviewOpen,
  onTest,
  onAuthenticate,
  onLogout,
  onUse,
  onReview,
}: {
  readonly profile: AwsProfileDescriptor;
  readonly catalog: AwsProfileCatalog;
  readonly observation?: AwsConnectionObservation;
  readonly associations: ModeProfiles;
  readonly pending: boolean;
  readonly reviewOpen: boolean;
  readonly onTest: () => void;
  readonly onAuthenticate: () => void;
  readonly onLogout: () => void;
  readonly onUse: (mode: Mode) => void;
  readonly onReview: (fields: AwsEditableFields) => void;
}) {
  const chain = profileChain(profile, catalog),
    root = chain.at(-1);
  const nativeAuthentication = chain.some((item) => ["login", "sso"].includes(item.kind));
  return (
    <>
      <div className="grid gap-1">
        <h3 className="m-0 text-[18px] font-semibold wrap-anywhere">{profile.name}</h3>
        <p className={note}>{profileMethodLabels[profile.kind]}</p>
      </div>
      <ConnectionIdentity observation={observation} />
      <div className="flex flex-wrap gap-2">
        <Button variant="quiet" disabled={pending} onClick={onTest}>
          Test connection
        </Button>
        {nativeAuthentication ? (
          <>
            <Button variant="primary" disabled={pending} onClick={onAuthenticate}>
              {observation?.state === "needs-auth" ? "Reconnect" : "Connect"}
            </Button>
            <Button variant="quiet" disabled={pending} onClick={onLogout}>
              Sign out…
            </Button>
          </>
        ) : null}
      </div>
      <p className={note}>
        A successful identity check confirms authentication. Permissions for each AWS operation are
        checked separately.
      </p>
      {profile.hasMfa ||
      profile.kind === "process" ||
      observation?.problem?.action === "terminal" ? (
        <div className="grid gap-1">
          <p className={note}>
            Complete any MFA or provider interaction in your terminal, then test this connection
            again.
          </p>
          <code className="text-caption wrap-anywhere">
            {terminalIdentityCommand(profile.name)}
          </code>
        </div>
      ) : null}
      {profile.kind === "sso" && !profile.ssoSession ? (
        <p className={note}>
          This profile uses legacy SSO configuration. Add a new Identity Center profile to use a
          refreshable shared session.
        </p>
      ) : null}
      {profile.sourceProfile ||
      profile.ssoSession ||
      profile.loginSession ||
      profile.credentialSource ? (
        <section className="grid gap-1">
          <h4 className={sectionHeading}>Credential relationship</h4>
          <p className="m-0 text-caption wrap-anywhere">
            {chain.map((item) => item.name).join(" → ")}
            {root?.ssoSession
              ? ` → Identity Center session ${root.ssoSession}`
              : root?.loginSession
                ? ` → Console session ${root.loginSession}`
                : profile.credentialSource
                  ? ` → ${profile.credentialSource}`
                  : ""}
          </p>
        </section>
      ) : null}
      {profile.diagnostics.map((diagnostic, index) => (
        <p
          key={index}
          role={diagnostic.severity === "error" ? "alert" : undefined}
          className={cx(
            "m-0 text-caption wrap-anywhere",
            diagnostic.severity === "error" ? "text-refuse" : "text-graphite",
          )}
        >
          {diagnostic.message}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        {(["dev", "prod"] as const).map((mode) => (
          <Button
            key={mode}
            variant="quiet"
            size="compact"
            disabled={pending}
            onClick={() => onUse(mode)}
          >
            {associations[mode] === profile.name ? <Check size={14} aria-hidden /> : null}Use for{" "}
            {mode === "dev" ? "Development" : "Production"}
          </Button>
        ))}
      </div>
      <div hidden={reviewOpen}>
        <ProfileFields
          key={`${profile.name}:${catalog.revision}`}
          profile={profile}
          profiles={catalog.profiles}
          sessions={catalog.sessions}
          busy={pending}
          onReview={onReview}
        />
      </div>
      <details>
        <summary className="cursor-pointer text-label">Configuration provenance</summary>
        <p className={cx(note, "pt-2")}>
          {profile.provenance.config ? "Defined in AWS config. " : ""}
          {profile.provenance.credentials ? "Has an entry in AWS credentials. " : ""}
          {profile.kind === "process"
            ? "External provider commands remain private and are managed by their own tooling."
            : "Credential values remain on the machine."}
        </p>
      </details>
    </>
  );
}
