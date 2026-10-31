import { dialogPrimaryActionClasses } from "../inspector-ui";
import { cx } from "../ui/classes";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { Check, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import type { DatabaseHistory } from "../../shared/database-history";
import type { DatabaseObservation, DatabaseWorkbench } from "../../shared/database-workbench";
import type {
  DatabaseApplicationResult,
  DatabaseApplicationReview,
  DatabaseOperationRecord,
} from "../../shared/database-application";
import type { DatabaseSession } from "../database-session";
import { call } from "../http";
import { historyApi, shortHash } from "./DatabaseHistory";
import {
  WorkbenchDialog,
  workbenchNoticeClasses,
  workbenchCardClasses,
  workbenchTextClasses,
  workbenchCodeClasses,
  workbenchHeadingClasses,
  workbenchPreClasses,
} from "./WorkbenchUI";
import { DatabaseCloud } from "./DatabaseCloud";

export function DatabaseEvidence({
  active,
  workbench,
  session,
  observation,
  dirty,
  onRefresh,
}: {
  readonly active: boolean;
  readonly workbench: DatabaseWorkbench;
  readonly session: DatabaseSession;
  readonly observation?: DatabaseObservation;
  readonly dirty: boolean;
  readonly onRefresh: () => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [history, setHistory] = useState<DatabaseHistory>();
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string>();
  const [application, setApplication] = useState<DatabaseApplicationReview>();
  const [confirmation, setConfirmation] = useState("");
  const [applying, setApplying] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [applicationResult, setApplicationResult] = useState<DatabaseApplicationResult>();
  const [operations, setOperations] = useState<DatabaseOperationRecord[]>([]);
  const [operationError, setOperationError] = useState<string>();
  const [cloudBusy, setCloudBusy] = useState(false);
  useBlocker({
    shouldBlockFn: () => applying || cloudBusy,
    enableBeforeUnload: applying || cloudBusy,
  });
  const request = useRef(0);
  const target = workbench.targets.find((item) => item.id === targetId);
  useEffect(() => {
    request.current++;
    session.invalidateObservation();
    setInspecting(false);
    setError(undefined);
    setApplication(undefined);
    setApplicationResult(undefined);
  }, [
    targetId,
    workbench.revision,
    workbench.targets.map((item) => item.identity).join(":"),
    session,
  ]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void historyApi
      .load()
      .then((next) => {
        if (current) {
          setHistory((previous) => {
            if (previous && previous.revision !== next.revision) session.invalidateObservation();
            return next;
          });
        }
      })
      .catch((error) => {
        if (current) setError(error instanceof Error ? error.message : String(error));
      });
    void call<DatabaseOperationRecord[]>("/database/application/operations")
      .then((next) => {
        if (current) {
          setOperations(next);
          setOperationError(undefined);
        }
      })
      .catch(() => {
        if (current)
          setOperationError(
            "Database operation history could not be read. Refresh before retrying a previous unconfirmed write.",
          );
      });
    return () => {
      current = false;
    };
  }, [active, workbench, session]);
  const inspect = async () => {
    if (!target || !history) return;
    const id = ++request.current;
    const sessionRequest = session.beginObservation(target.id);
    setInspecting(true);
    setError(undefined);
    try {
      const result = await call<DatabaseObservation>("/database/workbench/inspect", {
        targetId: target.id,
        expectedRevision: workbench.revision,
      });
      if (
        id === request.current &&
        result.targetId === target.id &&
        result.targetIdentity === target.identity
      ) {
        session.acceptObservation(sessionRequest, result);
        if (result.historyRevision !== history.revision) void historyApi.load().then(setHistory);
      }
    } catch (error) {
      if (id === request.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id === request.current) setInspecting(false);
    }
  };
  const reviewApplication = async (initialize = false) => {
    if (!target || dirty) return;
    const id = ++request.current;
    setReviewing(true);
    setError(undefined);
    setConfirmation("");
    try {
      const result = await call<DatabaseApplicationReview>("/database/application/review", {
        targetId: target.id,
        sourceHash: workbench.revision,
        ...(initialize ? { initialize: true } : {}),
      });
      if (id === request.current && result.targetIdentity === target.identity)
        setApplication(result);
    } catch (error) {
      if (id === request.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewing(false);
    }
  };
  const apply = async () => {
    if (!application) return;
    setApplying(true);
    setError(undefined);
    const sessionRequest = session.beginObservation(application.targetId);
    try {
      const result = await call<DatabaseApplicationResult>("/database/application/apply", {
        reviewId: application.id,
        confirmation,
      });
      setApplicationResult(result);
      setApplication(undefined);
      void call<DatabaseOperationRecord[]>("/database/application/operations")
        .then(setOperations)
        .catch(() =>
          setOperationError(
            "Operation history could not refresh. The application result above remains authoritative.",
          ),
        );
      if (result.observation) session.acceptObservation(sessionRequest, result.observation);
    } catch (error) {
      setError(
        `Application could not be confirmed: ${error instanceof Error ? error.message : String(error)} Inspect this target before retrying; database effects may be unconfirmed.`,
      );
      setApplication(undefined);
    } finally {
      setApplying(false);
    }
  };
  const current =
    observation &&
    observation.targetId === target?.id &&
    observation.targetIdentity === target.identity &&
    observation.savedRevision === workbench.revision &&
    (!history || observation.historyRevision === history.revision) &&
    observation.status !== "stale"
      ? observation
      : undefined;
  const migrationState = current?.migrationState.status ?? "unknown";
  const migrationLabel =
    migrationState === "current"
      ? "At saved storage contract"
      : migrationState === "pending"
        ? "Pending migration path"
        : migrationState === "divergent"
          ? "History diverges"
          : "Unknown";
  const physicalLabel =
    current?.physical.status === "matches"
      ? "Matches saved storage"
      : current?.historicalPhysical?.status === "matches"
        ? "Matches historical storage"
        : current?.physical.status === "differs"
          ? "Differs from saved storage"
          : "Unknown";
  return (
    <div data-ui="workbench-evidence" className="min-w-0">
      <header
        data-ui="workbench-content-heading"
        className="mt-2 mb-[18px] flex flex-wrap items-start justify-between gap-[14px]"
      >
        <div>
          <h2 className="mt-0 mb-1.25 font-condensed text-[21px] font-semibold">
            What does this database actually contain?
          </h2>
          <p className="m-0 max-w-[85ch] text-caption text-graphite">
            Compare saved source, migration history, and modeled physical storage. Every inspection
            is a read-only observation of the target you choose.
          </p>
        </div>
        <button className={buttonClasses({ variant: "quiet" })} onClick={onRefresh}>
          <RefreshCw size={14} /> Refresh source & targets
        </button>
      </header>
      <div data-ui="workbench-observation-heading" className="flex flex-wrap items-center gap-3">
        <label className="grid gap-1.25 text-meta vp-480:w-full">
          Database target
          <Select
            aria-label="Database target"
            value={targetId}
            disabled={applying || cloudBusy}
            onChange={(event) => setTargetId(event.target.value)}
            className="min-w-65 vp-480:min-w-0 vp-480:w-full"
          >
            <option value="">Choose a database…</option>
            {workbench.targets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
                {item.available
                  ? ""
                  : item.id === "production"
                    ? " · VPC task review"
                    : " · inspection unavailable"}
              </option>
            ))}
          </Select>
        </label>
        <button
          data-variant="primary"
          className={buttonClasses({ variant: "primary" })}
          disabled={
            !target?.available || !history || inspecting || applying || reviewing || cloudBusy
          }
          onClick={() => void inspect()}
        >
          {inspecting ? "Inspecting selected database…" : "Inspect database"}
        </button>
        {current?.migrationState.status === "pending" && target?.id === "local:postgres" ? (
          <button
            className={buttonClasses({ variant: "quiet" })}
            disabled={dirty || reviewing || applying}
            onClick={() => void reviewApplication()}
          >
            {reviewing ? "Reviewing target and pending migrations…" : "Review database application"}
          </button>
        ) : null}
        {current?.status === "observed" &&
        current.marker.status === "missing" &&
        target?.id === "local:postgres" ? (
          <button
            className={buttonClasses({ variant: "quiet" })}
            disabled={dirty || reviewing || applying}
            onClick={() => void reviewApplication(true)}
          >
            {reviewing
              ? "Checking empty database and planning…"
              : "Review empty database initialization"}
          </button>
        ) : null}
      </div>
      {target ? (
        <p data-ui="workbench-target-note" className="mt-3 text-caption text-graphite">
          {target.detail}
        </p>
      ) : (
        <p className="text-caption text-graphite">
          The Development / Production graph is not a database selection. Choose a target
          explicitly.
        </p>
      )}
      {target?.handoffs?.length ? (
        <DatabaseCloud
          target={target}
          dirty={dirty}
          onBusyChange={setCloudBusy}
          onOutcome={() => {
            void call<DatabaseOperationRecord[]>("/database/application/operations")
              .then(setOperations)
              .catch(() =>
                setOperationError(
                  "Operation history could not refresh. Inspect the recorded task before retrying.",
                ),
              );
          }}
        />
      ) : target?.id === "production" ? (
        <p data-ui="workbench-notice" className={workbenchNoticeClasses()}>
          No valid production targets were found. Configure the named production deployment in
          cdk-app/cdk.json, then refresh. No database command has run.
        </p>
      ) : null}
      {dirty ? (
        <p data-ui="workbench-notice" className={workbenchNoticeClasses()}>
          Your unsaved draft differs from saved source. This inspection compares the database with
          the <strong>saved authored contract</strong>; the editor draft is a separate proposal.
        </p>
      ) : null}
      {error ? (
        <p data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">
          {error}
        </p>
      ) : null}
      {applicationResult ? (
        <p
          data-ui="workbench-notice"
          className={workbenchNoticeClasses(
            ["applied", "unchanged"].includes(applicationResult.status) ? "neutral" : "warning",
          )}
          role="status"
        >
          {applicationResult.message}
        </p>
      ) : null}
      {applicationResult?.diagnostic ? (
        <p data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">
          <code>{applicationResult.diagnostic.code}</code>
          {applicationResult.diagnostic.sqlState
            ? ` · SQLSTATE ${applicationResult.diagnostic.sqlState}`
            : ""}{" "}
          · {applicationResult.diagnostic.action}{" "}
          <button
            className={cx("ml-2", buttonClasses({ variant: "quiet" }))}
            disabled={inspecting || applying}
            onClick={() => void inspect()}
          >
            Inspect again
          </button>
        </p>
      ) : null}
      {operationError ? (
        <p data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">
          {operationError}
        </p>
      ) : null}
      {operations.length ? (
        <details data-ui="workbench-card" className={workbenchCardClasses}>
          <summary>Database operation history ({operations.length})</summary>
          <p className={workbenchTextClasses}>
            Records survive Studio restarts. Interrupted operations are never resumed automatically;
            inspect the selected target and ledger before requesting another review.
          </p>
          {operations.map((operation) => (
            <div key={operation.id}>
              <strong>
                {operation.targetLabel} · {operation.kind} · {operation.status}
              </strong>
              <p className={cx(workbenchTextClasses, "text-caption text-graphite")}>
                {new Date(operation.startedAt).toLocaleString()} · last observed{" "}
                {new Date(operation.updatedAt).toLocaleString()} · last stage: {operation.stage} ·
                source {shortHash(operation.sourceHash)}
              </p>
              <p className={workbenchTextClasses}>
                {operation.result?.message ??
                  operation.message ??
                  "Execution was interrupted or is still running. Database effects are unconfirmed; inspect before retrying."}
              </p>
              {operation.result?.diagnostic ? (
                <code className={workbenchCodeClasses}>{operation.result.diagnostic.code}</code>
              ) : null}
              {operation.reviewDigest ? (
                <p className={cx(workbenchTextClasses, "text-caption")}>
                  Reviewed operation digest{" "}
                  <code className={workbenchCodeClasses}>{operation.reviewDigest}</code>
                </p>
              ) : null}
              {operation.taskArn ? (
                <p className={cx(workbenchTextClasses, "text-caption")}>
                  Task <code className={workbenchCodeClasses}>{operation.taskArn}</code> · client
                  token <code className={workbenchCodeClasses}>{operation.requestId}</code>. Inspect
                  this exact task and its CloudWatch stream before retrying.
                </p>
              ) : null}
              {operation.cloudRecovery ? (
                <details>
                  <summary>Recorded AWS recovery destination</summary>
                  <p className={workbenchTextClasses}>
                    Profile{" "}
                    <code className={workbenchCodeClasses}>{operation.cloudRecovery.profile}</code>{" "}
                    · region{" "}
                    <code className={workbenchCodeClasses}>{operation.cloudRecovery.region}</code> ·
                    cluster{" "}
                    <code className={workbenchCodeClasses}>{operation.cloudRecovery.cluster}</code>
                  </p>
                  <p className={workbenchTextClasses}>
                    CloudWatch group{" "}
                    <code className={workbenchCodeClasses}>{operation.cloudRecovery.logGroup}</code>{" "}
                    · stream{" "}
                    <code className={workbenchCodeClasses}>
                      {operation.cloudRecovery.logStream}
                    </code>
                  </p>
                  {!operation.taskArn ? (
                    <p className={workbenchTextClasses}>
                      If submission returned no ARN, locate the task with ECS list-tasks using
                      started-by <code className={workbenchCodeClasses}>{operation.requestId}</code>{" "}
                      in this recorded cluster. Do not submit another write to discover its status.
                    </p>
                  ) : null}
                </details>
              ) : null}
              {operation.migrations.length ? (
                <p className={cx(workbenchTextClasses, "text-caption")}>
                  Reviewed packages: {operation.migrations.join(", ")}
                </p>
              ) : null}
            </div>
          ))}
        </details>
      ) : null}
      <section
        data-ui="workbench-card workbench-representations"
        className={cx(workbenchCardClasses, "mt-4")}
        aria-label="Schema representations"
      >
        <h3 className={workbenchHeadingClasses}>Five distinct sources of evidence</h3>
        <dl className="mt-2 mb-0">
          <div className="grid grid-cols-[220px_1fr] gap-4 border-t border-rule py-2.25 text-caption vp-700:grid-cols-1 vp-700:gap-1.25">
            <dt className="font-semibold">Editor draft</dt>
            <dd className="m-0 wrap-anywhere">
              {dirty
                ? "Unsaved proposal · separate from this database comparison"
                : "Same text as saved source"}
            </dd>
          </div>
          <div className="grid grid-cols-[220px_1fr] gap-4 border-t border-rule py-2.25 text-caption vp-700:grid-cols-1 vp-700:gap-1.25">
            <dt className="font-semibold">Saved Prisma source</dt>
            <dd className="m-0 wrap-anywhere">
              {workbench.validation.valid ? "Valid contract" : "Invalid contract"} ·{" "}
              <code className={workbenchCodeClasses}>{shortHash(workbench.revision)}</code>
            </dd>
          </div>
          <div className="grid grid-cols-[220px_1fr] gap-4 border-t border-rule py-2.25 text-caption vp-700:grid-cols-1 vp-700:gap-1.25">
            <dt className="font-semibold">Emitted contract & migration graph</dt>
            <dd className="m-0 wrap-anywhere">
              {workbench.emitted?.message ?? "Emitted artifacts have not been observed."}
              <br />
              <span className="text-caption text-graphite">
                {workbench.emitted?.file} ·{" "}
                {workbench.emitted?.observedAt
                  ? `read ${new Date(workbench.emitted.observedAt).toLocaleTimeString()}`
                  : ""}{" "}
                · {history?.heads.length ?? "?"} migration graph heads
              </span>
            </dd>
          </div>
          <div className="grid grid-cols-[220px_1fr] gap-4 border-t border-rule py-2.25 text-caption vp-700:grid-cols-1 vp-700:gap-1.25">
            <dt className="font-semibold">Database marker & ledger</dt>
            <dd className="m-0 wrap-anywhere">
              {current?.status === "observed"
                ? `${current.marker.status} · ${current.ledger.length} recorded applications`
                : "Unknown · no successful target observation"}
            </dd>
          </div>
          <div className="grid grid-cols-[220px_1fr] gap-4 border-t border-rule py-2.25 text-caption vp-700:grid-cols-1 vp-700:gap-1.25">
            <dt className="font-semibold">Physical PostgreSQL schema</dt>
            <dd className="m-0 wrap-anywhere">
              {current ? physicalLabel : "Unknown · marker equality alone is insufficient"}
            </dd>
          </div>
        </dl>
      </section>
      <div
        data-ui="workbench-evidence-grid"
        className="my-4 grid grid-cols-3 gap-[14px] vp-1100:grid-cols-1"
      >
        <section data-ui="workbench-card" className={workbenchCardClasses}>
          <h3 className={workbenchHeadingClasses}>Saved source → migration history</h3>
          <div
            data-ui="workbench-evidence-status"
            className="mb-2 flex items-center gap-2 font-condensed text-[19px] font-semibold"
          >
            {history
              ? history.heads.includes(workbench.validation.storageHash ?? "")
                ? "Storage has a graph head"
                : "Needs investigation"
              : "Unknown"}
          </div>
          <p className={workbenchTextClasses}>
            {history?.heads.includes(workbench.validation.storageHash ?? "")
              ? "Saved storage matches a terminal contract in the on-disk migration graph. This does not establish whether any database has applied it."
              : "Compare saved source with migration history. A missing plan, branch or incomplete snapshot can prevent a known path."}
          </p>
          <p className={workbenchTextClasses}>
            <code className={workbenchCodeClasses}>
              {shortHash(workbench.validation.storageHash)}
            </code>{" "}
            · {history?.migrations.length ?? "?"} migration packages
          </p>
        </section>
        <section data-ui="workbench-card" className={workbenchCardClasses}>
          <h3 className={workbenchHeadingClasses}>Database migration evidence</h3>
          <div
            data-ui="workbench-evidence-status"
            className={`mb-2 flex items-center gap-2 font-condensed text-[19px] font-semibold ${migrationState === "current" ? "text-accept" : migrationState === "unknown" ? "" : "text-local"}`}
          >
            {migrationState === "current" ? <Check size={17} /> : null}
            {migrationLabel}
          </div>
          <p className={workbenchTextClasses}>
            {!current
              ? "No current observation for this target. A schema file and migration folders alone cannot establish database state."
              : current.marker.status === "missing"
                ? "No Prisma migration marker was found. The physical schema may still exist; do not infer an origin or sign it automatically."
                : `Marker: ${current.marker.status}. ${current.marker.storageHash ? `Storage contract ${shortHash(current.marker.storageHash)}.` : ""}`}
          </p>
          {current?.ledger.length ? (
            <p className={workbenchTextClasses}>
              {current.ledger.length} recorded migration applications
            </p>
          ) : null}
        </section>
        <section data-ui="workbench-card" className={workbenchCardClasses}>
          <h3 className={workbenchHeadingClasses}>Observed physical schema</h3>
          <div
            data-ui="workbench-evidence-status"
            className={`mb-2 flex items-center gap-2 font-condensed text-[19px] font-semibold ${current?.physical.status === "matches" ? "text-accept" : current?.physical.status === "differs" ? "text-local" : ""}`}
          >
            {physicalLabel}
          </div>
          <p className={workbenchTextClasses}>
            {!current
              ? "Inspect to compare PostgreSQL’s modeled schema with saved source. Matching a migration marker alone never proves a physical match."
              : current.status !== "observed"
                ? "No physical observation was obtained for this target. Review the inspection result below."
                : current.historicalPhysical?.status === "matches" &&
                    current.physical.status === "differs"
                  ? "The database matches the verified historical contract at its marker. A known forward path can explain the difference from saved source."
                  : current.historicalPhysical?.status === "differs"
                    ? "Physical storage differs from the known marker contract. Investigate drift before applying a migration."
                    : current.physical.status === "matches"
                      ? "Prisma strict verification accepts modeled physical storage. Data transformations, backfill completion and application correctness remain separate."
                      : "Physical evidence is incomplete or differs. Review detailed issues before deciding what changes are needed."}
          </p>
        </section>
      </div>
      {current ? (
        <section data-ui="workbench-card" className={workbenchCardClasses}>
          <h3 className={workbenchHeadingClasses}>{target?.label} · observation</h3>
          <p role="status" className={workbenchTextClasses}>
            {current.message}
          </p>
          <div
            data-ui="workbench-provenance"
            className="my-3 flex flex-wrap gap-x-5 gap-y-2 text-meta text-graphite"
          >
            <span>
              {current.status === "observed" ? "Observed" : "Attempted"}{" "}
              {new Date(current.observedAt).toLocaleString()}
            </span>
            <span>Baseline: {current.baseline.label}</span>
            <span>
              Source revision:{" "}
              <code className={workbenchCodeClasses}>{shortHash(current.savedRevision)}</code>
            </span>
            <span>
              Target identity:{" "}
              <code className={workbenchCodeClasses}>{shortHash(current.targetIdentity)}</code>
            </span>
          </div>
          {current.physical.issues.length || current.physical.warnings.length ? (
            <details open>
              <summary>Physical comparison findings</summary>
              {[...current.physical.issues, ...current.physical.warnings].map((issue, index) => (
                <pre key={index} className={workbenchPreClasses}>
                  {issue}
                </pre>
              ))}
            </details>
          ) : null}
          {current.historicalPhysical ? (
            <details open={current.historicalPhysical.status === "differs"}>
              <summary>
                Historical physical baseline · {shortHash(current.historicalPhysical.storageHash)} ·{" "}
                {current.historicalPhysical.status}
              </summary>
              <p className={workbenchTextClasses}>
                This separately verifies physical storage against the known contract named by the
                database marker.
              </p>
              {[...current.historicalPhysical.issues, ...current.historicalPhysical.warnings].map(
                (issue, index) => (
                  <pre key={index} className={workbenchPreClasses}>
                    {issue}
                  </pre>
                ),
              )}
            </details>
          ) : null}
          {current.ledger.length ? (
            <details>
              <summary>Database application history</summary>
              <p className={cx(workbenchTextClasses, "text-caption text-graphite")}>
                These are observed application times, separate from migration creation.
              </p>
              {current.ledger.map((entry, index) => (
                <p key={index} className={workbenchTextClasses}>
                  <strong>{entry.name}</strong> · applied{" "}
                  {new Date(entry.appliedAt).toLocaleString()}
                  <br />
                  <code className={workbenchCodeClasses}>
                    {shortHash(entry.from)} → {shortHash(entry.to)}
                  </code>
                </p>
              ))}
            </details>
          ) : null}
          <details>
            <summary>Evidence limits</summary>
            {current.limits.map((limit) => (
              <p key={limit} className={workbenchTextClasses}>
                {limit}
              </p>
            ))}
          </details>
        </section>
      ) : (
        <div
          data-ui="workbench-empty"
          className="rounded-md border border-dashed border-rule-strong p-[26px] text-label text-graphite"
        >
          {inspecting
            ? "Reading Prisma marker, application ledger and physical schema. No database writes…"
            : "Database state is unknown until an explicit inspection succeeds."}
        </div>
      )}
      <section data-ui="workbench-card" className={workbenchCardClasses} style={{ marginTop: 16 }}>
        <h3 className={workbenchHeadingClasses}>The next safe action</h3>
        <ol data-ui="workbench-step-list" className="my-[10px] pl-5 text-caption leading-[1.9]">
          <li>Review and save the source proposal.</li>
          <li>
            Generate application artifacts with{" "}
            <code className={workbenchCodeClasses}>
              npm --workspace @repo/database run generate
            </code>{" "}
            and review repositories, GraphQL authorization and client impact.
          </li>
          <li>Choose the intended historical baseline and plan a migration offline.</li>
          <li>Review SQL, constraints, destructive changes and data transformations.</li>
          <li>
            Apply the reviewed migration only with explicit target approval, then inspect again.
          </li>
        </ol>
        <p className={cx(workbenchTextClasses, "text-caption text-graphite")}>
          Local startup verifies storage without applying migrations, pruning users or setting up
          test identity. A failed verification leaves PostgreSQL available for inspection and a
          separately reviewed initialization/migration. Production retains private IAM/TLS access.
        </p>
      </section>
      {application ? (
        <WorkbenchDialog
          title="Authorize reviewed database application"
          busy={applying}
          onClose={() => setApplication(undefined)}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                autoFocus
                disabled={applying}
                onClick={() => setApplication(undefined)}
              >
                Back to database status
              </button>
              <button
                data-variant="primary"
                className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary" }))}
                disabled={applying || confirmation !== application.confirmation || dirty}
                onClick={() => void apply()}
              >
                {applying
                  ? "Applying reviewed database change…"
                  : application.kind === "initialize"
                    ? "Initialize reviewed empty database"
                    : "Apply reviewed migration"}
              </button>
            </>
          }
        >
          <p className="text-label">
            <strong>{application.targetLabel}</strong> ·{" "}
            {application.kind === "initialize"
              ? "Initialize verified empty storage"
              : "Apply reviewed migration path"}{" "}
            · target identity <code>{shortHash(application.targetIdentity)}</code> ·{" "}
            {shortHash(application.from)} → {shortHash(application.to)}
          </p>
          <ul className="text-caption leading-[1.8]">
            {application.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          {application.initialization ? (
            <section data-ui="workbench-card" className={workbenchCardClasses}>
              <h3 className={workbenchHeadingClasses}>Reviewed initialization SQL</h3>
              {application.initialization.operations.map((operation) => (
                <p key={operation.id} className={workbenchTextClasses}>
                  {operation.label} · {operation.operationClass}
                </p>
              ))}
              {application.initialization.statements
                ? application.initialization.statements.map((statement, index) => (
                    <pre
                      key={index}
                      className={cx("min-w-0 max-w-full overflow-auto", workbenchPreClasses)}
                    >
                      {statement.operationId} · {statement.phase}
                      {"\n"}
                      {statement.sql}
                      {statement.params?.length
                        ? `\nParameters: ${JSON.stringify(statement.params)}`
                        : ""}
                    </pre>
                  ))
                : application.initialization.sql.map((sql, index) => (
                    <pre
                      key={index}
                      className={cx("min-w-0 max-w-full overflow-auto", workbenchPreClasses)}
                    >
                      {sql}
                    </pre>
                  ))}
              <details>
                <summary>Prisma control schema and table DDL</summary>
                {application.initialization.controlSql?.map((statement, index) => (
                  <pre
                    key={index}
                    className={cx("min-w-0 max-w-full overflow-auto", workbenchPreClasses)}
                  >
                    {statement.sql}
                  </pre>
                ))}
              </details>
            </section>
          ) : null}
          {application.migrations.map((migration) => (
            <section data-ui="workbench-card" className={workbenchCardClasses} key={migration.id}>
              <h3 className={workbenchHeadingClasses}>{migration.name}</h3>
              {migration.operations.map((operation, index) => (
                <div key={index}>
                  <p className={workbenchTextClasses}>
                    <strong>{operation.label}</strong> · {operation.operationClass}
                  </p>
                  {operation.statements.map((statement, at) => (
                    <pre
                      key={at}
                      className={cx("min-w-0 max-w-full overflow-auto", workbenchPreClasses)}
                    >
                      {statement.phase}
                      {"\n"}
                      {statement.sql}
                      {statement.params?.length
                        ? `\nParameters: ${JSON.stringify(statement.params)}`
                        : ""}
                    </pre>
                  ))}
                </div>
              ))}
              <details>
                <summary>Executable migration source</summary>
                <pre className={cx("min-w-0 max-w-full overflow-auto", workbenchPreClasses)}>
                  {migration.source}
                </pre>
              </details>
            </section>
          ))}
          <p
            data-ui="workbench-notice"
            className={cx("text-label", workbenchNoticeClasses("warning"))}
          >
            This changes the selected database and may transform or delete data. Source undo does
            not roll back a database. The reviewed target and historical schema are checked again
            before execution.
          </p>
          <label data-ui="workbench-confirmation" className="mt-4 grid gap-2 text-label">
            Type <strong>{application.confirmation}</strong> to authorize this application
            <TextInput
              aria-label="Confirm database target"
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              disabled={applying}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
        </WorkbenchDialog>
      ) : null}
    </div>
  );
}
