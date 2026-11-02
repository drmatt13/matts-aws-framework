import { useEffect, useRef } from "react";
import type {
  ProfileReview,
  ProfileDeletionReview as DeletionReview,
  LogoutReview,
} from "../aws-connections-api";
import type { ModeProfiles } from "../aws-profile-selection";
import { Button } from "../ui/Button";

const note = "m-0 text-caption text-graphite";
const heading = "m-0 text-body font-semibold";

export function ProfileDeletionReview({
  review,
  associations,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly review: DeletionReview;
  readonly associations: ModeProfiles;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const modes = [
    associations.dev === review.name && "Development",
    associations.prod === review.name && "Production",
  ].filter(Boolean);
  const files = review.files.length
    ? `${review.files.join(" and ")} ${review.files.length === 1 ? "file" : "files"}`
    : "configuration";
  return (
    <section
      className="grid gap-4 rounded-md border border-rule-strong p-4"
      aria-label="Delete AWS profile confirmation"
    >
      <h3 className={`${heading} sticky top-0 z-10 bg-sheet py-1`}>
        Delete profile {review.name}?
      </h3>
      <p className="m-0 text-label">
        Remove this profile from your machine’s AWS {files}. Other profiles and shared sign-in
        sessions will be kept. AWS resources are unaffected.
      </p>
      {review.name === "default" ? (
        <p className={note}>
          The default entry will remain in Studio as not configured, ready to set up again.
        </p>
      ) : null}
      {modes.length ? (
        <p className={note}>
          {modes.join(" and ")} will have no selected profile in this repository. Choose another
          profile before running AWS operations.
        </p>
      ) : null}
      {review.dependentProfiles.length ? (
        <p className={note}>Profiles using this source: {review.dependentProfiles.join(", ")}.</p>
      ) : null}
      {review.blockers.length ? (
        <div className="grid gap-2" role="alert">
          <p className="m-0 text-label font-medium text-refuse">
            This profile cannot be deleted yet.
          </p>
          <ul className="m-0 grid gap-1 pl-5 text-caption text-refuse">
            {review.blockers.map((blocker, index) => (
              <li key={index}>{blocker}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button ref={cancel} disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          tone="danger"
          disabled={pending || !!review.blockers.length}
          onClick={onConfirm}
        >
          Delete profile
        </Button>
      </div>
    </section>
  );
}

export function ProfileChangeReview({
  review,
  pending,
  onBack,
  onSave,
}: {
  readonly review: ProfileReview;
  readonly pending: boolean;
  readonly onBack: () => void;
  readonly onSave: () => void;
}) {
  return (
    <section
      className="grid gap-3 rounded-md border border-rule-strong p-4"
      aria-label="AWS profile change review"
    >
      <h3 className={heading}>
        Review {review.create ? "new profile" : "configuration changes"}: {review.name}
      </h3>
      <p className={note}>
        Only these settings will change. Existing comments and unrelated configuration are
        preserved.
      </p>
      <dl className="m-0 grid gap-3 text-label">
        {review.changes.map((change) => (
          <div key={change.field} className="grid min-w-0 gap-1">
            <dt className="font-medium">{change.field}</dt>
            <dd className="m-0 font-mono text-caption wrap-anywhere">
              {change.before ? `${change.before} → ` : ""}
              {change.after || "Remove setting"}
            </dd>
          </div>
        ))}
      </dl>
      {review.affectedProfiles.length ? (
        <p className={note}>Affected profiles: {review.affectedProfiles.join(", ")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" disabled={pending} onClick={onSave}>
          Save profile
        </Button>
      </div>
    </section>
  );
}

export function ProfileLogoutReview({
  review,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly review: LogoutReview;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <section
      className="grid gap-3 rounded-md border border-rule-strong p-4"
      aria-label="AWS sign-out review"
    >
      <h3 className={heading}>
        {review.method === "sso"
          ? "Sign out of all Identity Center sessions"
          : "Sign out of shared Console session"}
      </h3>
      <p className="m-0 text-label">{review.message}</p>
      <p className={note}>
        Affected profiles: {review.affectedProfiles.join(", ") || "This session"}. Already-issued
        role credentials can remain valid until they expire.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button tone="danger" disabled={pending} onClick={onConfirm}>
          Sign out
        </Button>
      </div>
    </section>
  );
}
