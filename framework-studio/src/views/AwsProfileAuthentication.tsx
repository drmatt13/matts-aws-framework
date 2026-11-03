import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../ui/Button";
import { authenticationFinished, type AuthenticationSession } from "../aws-connections-api";
import { inspectorNoteClasses } from "../inspector-ui";
import { ProfileStatusLine } from "./AwsProfileDetails";
import { ProfileFlow } from "./AwsProfileReviews";

export function AuthenticationProgress({
  session,
  pending,
  onCancel,
  onConfirm,
  children,
}: {
  readonly session: AuthenticationSession;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (accepted: boolean) => void;
  /** The step that follows a completed sign-in: an account choice or a profile review. */
  readonly children?: ReactNode;
}) {
  const finished = authenticationFinished(session);
  const confirming = !!session.confirmation && session.state === "confirmation-required";
  return (
    <ProfileFlow
      label="AWS sign-in progress"
      kind={session.method === "sso" ? "IAM Identity Center sign-in" : "AWS Console sign-in"}
      title={`Sign in to ${session.profile}`}
      actions={
        !finished ? (
          <>
            <Button variant="quiet" disabled={pending} onClick={onCancel}>
              Cancel sign-in
            </Button>
            {confirming ? (
              <>
                <Button variant="quiet" disabled={pending} onClick={() => onConfirm(false)}>
                  Keep previous identity
                </Button>
                <Button variant="primary" disabled={pending} onClick={() => onConfirm(true)}>
                  Continue with selected identity
                </Button>
              </>
            ) : null}
          </>
        ) : undefined
      }
    >
      <ProfileStatusLine
        role={session.state === "failed" ? "alert" : "status"}
        tone={
          session.state === "failed"
            ? "refuse"
            : session.state === "complete"
              ? "accept"
              : "local"
        }
      >
        {session.message}
      </ProfileStatusLine>
      {session.authorizationUrl && !finished ? (
        <a
          href={session.authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-label underline decoration-rule-strong underline-offset-[3px] wrap-anywhere hover:decoration-ink"
        >
          Continue sign-in in your browser
          <ExternalLink size={12} className="shrink-0 text-graphite" aria-hidden />
        </a>
      ) : null}
      {confirming ? (
        <div className="grid min-w-0 gap-2">
          <p className={inspectorNoteClasses}>{session.confirmation!.message}</p>
          <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-caption">
            <dt className="text-graphite">Previous principal</dt>
            <dd className="m-0 min-w-0 wrap-anywhere">
              <code>{session.confirmation!.previousArn}</code>
            </dd>
            <dt className="text-graphite">Selected principal</dt>
            <dd className="m-0 min-w-0 wrap-anywhere">
              <code>{session.confirmation!.nextArn}</code>
            </dd>
          </dl>
        </div>
      ) : null}
      {session.affectedProfiles.length > 1 ? (
        <p className={inspectorNoteClasses}>
          Shared session: {session.affectedProfiles.join(", ")}
        </p>
      ) : null}
      {children ? <div className="grid min-w-0 border-t border-rule pt-3">{children}</div> : null}
    </ProfileFlow>
  );
}
