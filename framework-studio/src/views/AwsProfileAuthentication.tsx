import { Button } from "../ui/Button";
import { authenticationFinished, type AuthenticationSession } from "../aws-connections-api";
const note = "m-0 text-caption text-graphite";
const sectionHeading = "m-0 text-body font-semibold";

export function AuthenticationProgress({
  session,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly session: AuthenticationSession;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (accepted: boolean) => void;
}) {
  return (
    <section
      className="grid gap-3 rounded-md border border-rule-strong bg-wash p-4"
      aria-label="AWS sign-in progress"
    >
      <h3 className={sectionHeading}>Sign in to {session.profile}</h3>
      <p
        className="m-0 text-label wrap-anywhere"
        role={session.state === "failed" ? "alert" : "status"}
      >
        {session.message}
      </p>
      {session.authorizationUrl && !authenticationFinished(session) ? (
        <a
          href={session.authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-label underline wrap-anywhere"
        >
          Continue sign-in in your browser
        </a>
      ) : null}
      {session.confirmation && session.state === "confirmation-required" ? (
        <div className="grid gap-3">
          <p className={note}>{session.confirmation.message}</p>
          <dl className="m-0 grid gap-1 text-caption">
            <dt>Previous principal</dt>
            <dd className="m-0 font-mono wrap-anywhere">{session.confirmation.previousArn}</dd>
            <dt>Selected principal</dt>
            <dd className="m-0 font-mono wrap-anywhere">{session.confirmation.nextArn}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => onConfirm(false)}>
              Keep previous identity
            </Button>
            <Button variant="primary" disabled={pending} onClick={() => onConfirm(true)}>
              Continue with selected identity
            </Button>
          </div>
        </div>
      ) : null}
      {!authenticationFinished(session) ? (
        <Button
          variant="quiet"
          className="justify-self-start"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel sign-in
        </Button>
      ) : null}
      {session.affectedProfiles.length > 1 ? (
        <p className={note}>Shared session: {session.affectedProfiles.join(", ")}</p>
      ) : null}
    </section>
  );
}
