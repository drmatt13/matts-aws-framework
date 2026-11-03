import { useEffect, useRef, type ReactNode } from "react";
import type {
  ProfileReview,
  ProfileDeletionReview as DeletionReview,
  LogoutReview,
} from "../aws-connections-api";
import type { ModeProfiles } from "../aws-profile-selection";
import {
  inspectorFieldClasses,
  inspectorHeaderClasses,
  inspectorNoteClasses,
  inspectorTitleClasses,
} from "../inspector-ui";
import { Button } from "../ui/Button";
import { InspectorKind } from "./InspectorUI";

/**
 * A review or sign-in replaces the profile view: an inspector header naming the step, its
 * content, then back/cancel before the commit action in a row that stays in view.
 */
export function ProfileFlow({
  label,
  kind,
  title,
  actions,
  children,
}: {
  readonly label: string;
  readonly kind: string;
  readonly title: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-1 flex-col">
      <header className={`${inspectorHeaderClasses} sticky top-0 z-10 bg-sheet`}>
        <InspectorKind>{kind}</InspectorKind>
        <h3 tabIndex={-1} className={inspectorTitleClasses}>
          {title}
        </h3>
      </header>
      <div className="grid min-w-0 content-start gap-3 px-5 py-4">{children}</div>
      {actions ? (
        <div className="sticky bottom-0 z-10 mt-auto flex flex-wrap justify-end gap-2 border-t border-rule bg-sheet px-5 py-3">
          {actions}
        </div>
      ) : null}
    </section>
  );
}

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
    <ProfileFlow
      label="Delete AWS profile confirmation"
      kind="Review deletion"
      title={`Delete profile ${review.name}?`}
      actions={
        <>
          <Button ref={cancel} variant="quiet" disabled={pending} onClick={onCancel}>
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
        </>
      }
    >
      <p className="m-0 text-label">
        Remove this profile from your machine’s AWS {files}. Other profiles and shared sign-in
        sessions will be kept. AWS resources are unaffected.
      </p>
      {review.name === "default" ? (
        <p className={inspectorNoteClasses}>
          The default entry will remain in Studio as not configured, ready to set up again.
        </p>
      ) : null}
      {modes.length ? (
        <p className={inspectorNoteClasses}>
          {modes.join(" and ")} will have no selected profile in this repository. Choose another
          profile before running AWS operations.
        </p>
      ) : null}
      {review.dependentProfiles.length ? (
        <p className={inspectorNoteClasses}>
          Profiles using this source: {review.dependentProfiles.join(", ")}.
        </p>
      ) : null}
      {review.blockers.length ? (
        <div className="grid gap-1 border-l-2 border-refuse pl-2" role="alert">
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
    </ProfileFlow>
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
    <ProfileFlow
      label="AWS profile change review"
      kind={review.create ? "Review new profile" : "Review configuration changes"}
      title={review.name}
      actions={
        <>
          <Button variant="quiet" disabled={pending} onClick={onBack}>
            Back
          </Button>
          <Button variant="primary" disabled={pending} onClick={onSave}>
            Save profile
          </Button>
        </>
      }
    >
      <p className={inspectorNoteClasses}>
        Only these settings will change. Existing comments and unrelated configuration are
        preserved.
      </p>
      <dl className="m-0 grid min-w-0">
        {review.changes.map((change) => (
          <div key={change.field} className={inspectorFieldClasses}>
            <dt className="text-label font-medium">
              <code>{change.field}</code>
            </dt>
            <dd className="m-0 text-caption wrap-anywhere">
              {change.before ? (
                <>
                  <code className="text-graphite">{change.before}</code> →{" "}
                </>
              ) : null}
              {change.after ? <code>{change.after}</code> : "Remove setting"}
            </dd>
          </div>
        ))}
      </dl>
      {review.affectedProfiles.length ? (
        <p className={inspectorNoteClasses}>
          Affected profiles: {review.affectedProfiles.join(", ")}
        </p>
      ) : null}
    </ProfileFlow>
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
    <ProfileFlow
      label="AWS sign-out review"
      kind="Review sign-out"
      title={
        review.method === "sso"
          ? "Sign out of all Identity Center sessions"
          : "Sign out of shared Console session"
      }
      actions={
        <>
          <Button variant="quiet" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button tone="danger" disabled={pending} onClick={onConfirm}>
            Sign out
          </Button>
        </>
      }
    >
      <p className="m-0 text-label">{review.message}</p>
      <p className={inspectorNoteClasses}>
        Affected profiles: {review.affectedProfiles.join(", ") || "This session"}. Already-issued
        role credentials can remain valid until they expire.
      </p>
    </ProfileFlow>
  );
}
