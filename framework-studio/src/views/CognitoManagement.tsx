import { dialogPrimaryActionClasses } from "../inspector-ui";
import { useEffect, useRef, useState } from "react";
import type { IdentitySelection } from "../../shared/identity";
import type {
  CognitoAction,
  CognitoOperation,
  CognitoOperationRecord,
  CognitoOperationResult,
  CognitoOperationReview,
} from "../../shared/identity-operations";
import { call } from "../http";
import { buttonClasses } from "../ui/Button";
import { Select, TextInput } from "../ui/FormControls";
import { noticeClasses } from "../ui/Surface";
import { cx } from "../ui/classes";
import { DocumentCard, documentFieldsetClasses, documentLabelClasses } from "./DocumentUI";
import { WorkbenchDialog } from "./WorkbenchUI";

export const cognitoManagementApi = {
  history: () => call<readonly CognitoOperationRecord[]>("/identity/operations"),
  review: (selection: IdentitySelection, operation: CognitoOperation) =>
    call<CognitoOperationReview>("/identity/operations/review", { selection, operation }),
  apply: (id: string, confirmation: string, productionConfirmation?: string) =>
    call<CognitoOperationResult>("/identity/operations/apply", {
      id,
      confirmation,
      productionConfirmation,
    }),
};
const labels: Record<CognitoAction, string> = {
  "create-user": "Create user without invitation",
  "create-group": "Create group without IAM role",
  "add-to-group": "Add user to group",
  "remove-from-group": "Remove user from group",
  "enable-user": "Enable user",
  "disable-user": "Disable user",
};

/** Live-operation approval, separate from source and read-only inspection. */
export function CognitoManagement({
  selection,
  onChanged,
  active = true,
}: {
  readonly selection: IdentitySelection;
  readonly onChanged?: () => void;
  readonly active?: boolean;
}) {
  const [action, setAction] = useState<CognitoAction>("create-user");
  const [username, setUsername] = useState(""),
    [email, setEmail] = useState(""),
    [givenName, setGivenName] = useState(""),
    [familyName, setFamilyName] = useState("");
  const [group, setGroup] = useState(""),
    [description, setDescription] = useState("");
  const [review, setReview] = useState<CognitoOperationReview>();
  const [confirmation, setConfirmation] = useState(""),
    [productionConfirmation, setProductionConfirmation] = useState("");
  const [busy, setBusy] = useState(false),
    [applying, setApplying] = useState(false),
    [error, setError] = useState("");
  const [result, setResult] = useState<CognitoOperationResult>(),
    [history, setHistory] = useState<readonly CognitoOperationRecord[]>([]);
  const request = useRef(0);
  const selected = [selection.profile, selection.deployment, selection.region].join("|");
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const refreshHistory = async () => setHistory(await cognitoManagementApi.history());
  useEffect(() => {
    request.current++;
    setReview(undefined);
    setConfirmation("");
    setProductionConfirmation("");
    setResult(undefined);
    setError("");
    if (!applying) setBusy(false);
    void refreshHistory().catch(() =>
      setError(
        "Operation history is unavailable. Inspect the exact pool before considering a write.",
      ),
    );
  }, [selected]);
  // Retain entered subjects across panels, without allowing a late read to open
  // an approval after its panel has become inactive.
  useEffect(() => {
    if (!active) {
      request.current++;
      setReview(undefined);
      setConfirmation("");
      setProductionConfirmation("");
      if (!applying) setBusy(false);
    }
  }, [active, applying]);
  const operation = (): CognitoOperation =>
    action === "create-user"
      ? { action, username, email, givenName, familyName }
      : action === "create-group"
        ? { action, group, description }
        : action === "add-to-group" || action === "remove-from-group"
          ? { action, username, group }
          : { action, username };
  const prepare = async () => {
    const generation = ++request.current,
      key = selected;
    setBusy(true);
    setError("");
    setResult(undefined);
    setConfirmation("");
    setProductionConfirmation("");
    try {
      const next = await cognitoManagementApi.review(selection, operation());
      if (generation === request.current && key === selectedNow.current) setReview(next);
    } catch (error) {
      if (generation === request.current)
        setError(error instanceof Error ? error.message : "Review failed. No write was requested.");
    } finally {
      if (generation === request.current) setBusy(false);
    }
  };
  const apply = async () => {
    if (!review) return;
    const key = selected;
    setBusy(true);
    setApplying(true);
    setError("");
    try {
      const next = await cognitoManagementApi.apply(
        review.id,
        confirmation,
        productionConfirmation || undefined,
      );
      if (key === selectedNow.current) setResult(next);
      setReview(undefined);
      await refreshHistory();
      onChanged?.();
    } catch {
      setReview(undefined);
      setError(
        "The request or response was interrupted; the cloud outcome is not established here. Refresh operation history and inspect the exact reviewed pool before another approval. Studio does not retry the write.",
      );
      await refreshHistory().catch(() => {});
    } finally {
      setBusy(false);
      setApplying(false);
    }
  };
  const currentHistory = history.filter(
    (record) =>
      record.deployment === selection.deployment &&
      record.region === selection.region &&
      record.profile === selection.profile,
  );
  return (
    <DocumentCard className="mb-3" aria-label="Cognito user and group management">
      <h2 className="mt-0 mb-2 text-[15px] leading-[1.4]">User and group operations</h2>
      <p className="mt-0 mb-2 text-label leading-[1.5] last:mb-0">
        Review one action against the verified deployment-owned pool, then explicitly approve its
        exact user/group, pool and account. Creating users sends no invitation. Password, reset and
        user-deletion operations are unavailable.
      </p>
      <p className="mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite">
        Profile <code>{selection.profile}</code>{" · deployment "}
        <code>{selection.deployment || "not selected"}</code> · {selection.region}. Review reads
        AWS; it does not write. Production requires separate operation-specific authorization.
      </p>
      {error ? (
        <p
          className={cx(
            noticeClasses(),
            "mt-0 mb-2 text-label leading-[1.5] last:mb-0 flex flex-wrap items-center gap-x-3 gap-y-2",
          )}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <fieldset className={documentFieldsetClasses} disabled={busy}>
        <legend className="px-1 text-label">Requested action</legend>
        <label className={cx("max-w-160", documentLabelClasses, "max-w-[640px]")}>
          Action
          <Select
            className="w-full"
            aria-label="Cognito management action"
            value={action}
            onChange={(event) => {
              setAction(event.target.value as CognitoAction);
              setReview(undefined);
              setResult(undefined);
            }}
          >
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        {action !== "create-group" ? (
          <label className={cx("max-w-160", documentLabelClasses)}>
            Username
            <TextInput
              className="w-full"
              aria-label="Cognito management username"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="campaign.user@example.invalid"
            />
          </label>
        ) : null}
        {action === "create-user" ? (
          <>
            <label className={cx("max-w-160", documentLabelClasses)}>
              Email
              <TextInput
                className="w-full"
                aria-label="Cognito management email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="campaign.user@example.invalid"
              />
            </label>
            <label className={cx("max-w-160", documentLabelClasses)}>
              Given name
              <TextInput
                className="w-full"
                aria-label="Cognito management given name"
                value={givenName}
                onChange={(event) => setGivenName(event.target.value)}
              />
            </label>
            <label className={cx("max-w-160", documentLabelClasses)}>
              Family name
              <TextInput
                className="w-full"
                aria-label="Cognito management family name"
                value={familyName}
                onChange={(event) => setFamilyName(event.target.value)}
              />
            </label>
            <p className="mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite">
              Cognito generates a temporary credential server-side. It is never retrieved or
              delivered here; this tool does not complete sign-in or assert email verification.
            </p>
          </>
        ) : null}
        {action === "create-group" ||
        action === "add-to-group" ||
        action === "remove-from-group" ? (
          <label className={cx("max-w-160", documentLabelClasses)}>
            Group
            <TextInput
              className="w-full"
              aria-label="Cognito management group"
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              placeholder="campaign-reader"
            />
          </label>
        ) : null}
        {action === "create-group" ? (
          <label className={cx("max-w-160", documentLabelClasses)}>
            Group description
            <TextInput
              className="w-full"
              aria-label="Cognito management group description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        ) : null}
        <button
          className={buttonClasses({ variant: "primary" })}
          disabled={!selection.deployment || !selection.profile || !selection.region}
          onClick={() => void prepare()}
        >
          Review Cognito operation
        </button>
      </fieldset>
      {applying ? (
        <p className="mt-0 mb-2 text-label leading-[1.5] last:mb-0" role="status">
          Applying the reviewed operation. Switching views or losing the response does not undo a
          request Cognito already accepted.
        </p>
      ) : null}
      {result ? (
        <div role="status">
          <strong>
            {result.action} · {result.status}
          </strong>
          <p className="mt-0 mb-2 text-label leading-[1.5] last:mb-0">{result.message}</p>
          <p className="mt-0 mb-2 text-label leading-[1.5] last:mb-0">
            Account {result.account} · {result.region} · pool <code>{result.poolId}</code> ·
            follow-up {result.verification}. Operation <code>{result.id}</code>.
          </p>
        </div>
      ) : null}
      <details className="mt-3">
        <summary className="cursor-pointer py-1 text-label [[open]>&]:mb-2">
          Operation history ({currentHistory.length})
        </summary>
        <p className="mt-0 mb-2 text-label leading-[1.5] last:mb-0 text-graphite">
          History excludes entered user/email/group values and raw AWS responses. Match the subject
          digest with your review, and correlate CloudTrail using action, pool, account, time and
          caller ARN before another write. Digests are correlation references, not anonymous
          identifiers. An interrupted record remains uncertain after restart; no write is replayed.
        </p>
        <button
          className={buttonClasses({ variant: "quiet" })}
          disabled={busy}
          onClick={() =>
            void refreshHistory().catch(() =>
              setError("History could not be read. Inspect the exact pool before another write."),
            )
          }
        >
          Refresh Cognito operation history
        </button>
        {currentHistory.map((record) => (
          <p className="mt-0 mb-2 text-label leading-[1.5] last:mb-0" key={record.id}>
            {record.startedAt} · {record.action} · {record.status} · {record.poolId}
            <br />
            Caller <code>{record.actorArn ?? "unknown"}</code> · subject{" "}
            <code>{record.subjectDigest}</code>
            <br />
            {record.message}
            {record.code ? ` (${record.code})` : ""}
          </p>
        ))}
      </details>
      {review && active ? (
        <WorkbenchDialog
          titleClassName="mt-0 mb-2 font-sans text-[15px] font-semibold leading-[1.4]"
          title="Approve Cognito operation"
          busy={busy}
          onClose={() => setReview(undefined)}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                disabled={busy}
                onClick={() => setReview(undefined)}
              >
                Cancel
              </button>
              <button
                className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary" }))}
                data-variant="primary"
                disabled={
                  busy ||
                  confirmation !== review.confirmation ||
                  (!!review.productionConfirmation &&
                    productionConfirmation !== review.productionConfirmation)
                }
                onClick={() => void apply()}
              >
                {review.noEffect
                  ? "Record reviewed unchanged state"
                  : "Apply exact Cognito operation"}
              </button>
            </>
          }
        >
          <p className="text-label mt-0 mb-2 leading-[1.5] last:mb-0">
            <strong>{review.target.mode === "prod" ? "PRODUCTION" : "Development"}</strong> ·
            account <code>{review.target.account}</code> · {review.target.region} · profile{" "}
            {review.target.profile}
          </p>
          <p className="text-label mt-0 mb-2 leading-[1.5] last:mb-0">
            Pool <code>{review.target.poolId}</code>
            <br />
            <code>{review.target.poolArn}</code>
          </p>
          {review.target.actorArn ? (
            <p className="text-label mt-0 mb-2 leading-[1.5] last:mb-0">
              Caller <code>{review.target.actorArn}</code>
            </p>
          ) : null}
          <p className="text-label mt-0 mb-2 leading-[1.5] last:mb-0">
            <strong>{labels[review.operation.action]}</strong>
          </p>
          <pre className="min-w-0 max-w-full overflow-auto max-h-[350px] text-caption">
            {JSON.stringify(review.operation, null, 2)}
          </pre>
          <p className="text-label mt-0 mb-2 leading-[1.5] last:mb-0">
            Subject correlation digest <code>{review.subjectDigest}</code>. Save this review
            reference if you need to correlate a later uncertain outcome.
          </p>
          <p className="text-label mt-0 mb-2 leading-[1.5] last:mb-0">
            Current user:{" "}
            {review.before.user
              ? `${review.before.user.username} · ${review.before.user.enabled ? "enabled" : "disabled"} · ${review.before.user.status ?? "status unknown"}`
              : "not present / not applicable"}
            . Current group: {review.before.group?.name ?? "not present / not applicable"}
            {review.before.group?.roleArn ? ` · role ${review.before.group.roleArn}` : ""}.
          </p>
          <ul className="text-caption leading-[1.8]">
            {review.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          <label className={documentLabelClasses}>
            Type <code>{review.confirmation}</code>
            <TextInput
              className="w-full"
              aria-label="Cognito operation confirmation"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          {review.productionConfirmation ? (
            <div className="text-refuse wrap-anywhere">
              <p className="mt-0 mb-2 text-label leading-[1.5] last:mb-0">
                This changes a real production user pool. User access and future role claims can
                change. This approval is separate from source, deployment and prior operations.
              </p>
              <label className={documentLabelClasses}>
                Separately type <code>{review.productionConfirmation}</code>
                <TextInput
                  className="w-full"
                  aria-label="Production Cognito operation authorization"
                  autoComplete="off"
                  value={productionConfirmation}
                  onChange={(event) => setProductionConfirmation(event.target.value)}
                />
              </label>
            </div>
          ) : null}
        </WorkbenchDialog>
      ) : null}
    </DocumentCard>
  );
}
