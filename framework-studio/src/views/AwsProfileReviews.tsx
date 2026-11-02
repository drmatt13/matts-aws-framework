import type { ProfileReview, LogoutReview } from "../aws-connections-api";
import { Button } from "../ui/Button";

const note = "m-0 text-caption text-graphite";
const heading = "m-0 text-body font-semibold";

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
