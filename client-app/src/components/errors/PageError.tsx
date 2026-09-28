import { useNavigate } from "@tanstack/react-router";

import Button from "#/components/Button";

interface PageErrorProps {
  title: string;
  message: string;
  // Renders a "Try again" button; use a query's refetch for recoverable loads.
  onRetry?: () => void;
  retryLabel?: string;
  // Renders a navigation button (e.g. "Go home" -> "/").
  actionLabel?: string;
  actionTo?: string;
  actionParams?: Record<string, string>;
}

// Reusable page-level error for resource/data-loading failures. Never touches
// the session — a failed resource load stays recoverable. For current-user or
// session failures use SessionError instead.
// Full-screen centered glass card, no app chrome, so it drops in wherever a
// route currently early-returns an error component.
const PageError = ({
  title,
  message,
  onRetry,
  retryLabel = "Try again",
  actionLabel,
  actionTo,
  actionParams,
}: PageErrorProps) => {
  const navigate = useNavigate();

  const handleNavigate = () => {
    // `navigate` is strictly typed over the route tree; a generic `actionTo`
    // string can't be proven to match, so cast the options once here to keep
    // every call site clean.
    void navigate({
      to: actionTo,
      params: actionParams,
    } as Parameters<typeof navigate>[0]);
  };

  return (
    <div className="auth-stage">
      <div className="auth-card max-w-md text-center">
        <p className="text-lg font-semibold tracking-tight">{title}</p>
        <p className="mt-2 text-sm text-muted">{message}</p>
        {(onRetry || (actionLabel && actionTo)) && (
          <div className="mt-4 flex justify-center gap-3">
            {onRetry && (
              <Button style="secondary" text={retryLabel} onClick={onRetry} />
            )}
            {actionLabel && actionTo && (
              <Button
                style="primary"
                text={actionLabel}
                onClick={handleNavigate}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PageError;
