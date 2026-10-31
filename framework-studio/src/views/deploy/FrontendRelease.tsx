import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";

import { TextInput, Select, Textarea } from "../../ui/FormControls";

import { statePanelClasses, factsClasses } from "./DeployUI";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "../../http";
import type {
  FrontendReleaseResult,
  FrontendReleaseReview,
  FrontendReleaseSettings,
  FrontendSettingsReview,
} from "../../../shared/frontend-release";
import type {
  DeploymentIdentityRequest,
  DeploymentIdentityReview,
} from "../../../shared/deployment-identities";

// Native disclosures retain their open-content rhythm without styling nested forms.
const releaseDisclosureClasses = "open:[&>:not(summary)]:mt-3 open:[&>:not(summary)]:mb-0";
const releaseFieldClasses = "grid min-w-0 gap-1 text-label";
const releasePreClasses =
  "max-h-75 max-w-full overflow-auto bg-paper p-3 whitespace-pre-wrap wrap-anywhere";

export function FrontendRelease({
  deployment,
  profile,
  region,
}: {
  deployment: string;
  profile?: string;
  region?: string;
}) {
  const settingsQuery = useQuery({
    queryKey: ["frontend-release", "settings"],
    queryFn: () =>
      call<{ settings: FrontendReleaseSettings; hash: string }>("/frontend-release/settings"),
  });
  const historyQuery = useQuery({
    queryKey: ["frontend-release", "history"],
    queryFn: () =>
      call<{ review: FrontendReleaseReview; result: FrontendReleaseResult }[]>(
        "/frontend-release/history",
      ),
  });
  const [settings, setSettings] = useState<FrontendReleaseSettings>();
  const [settingsReview, setSettingsReview] = useState<FrontendSettingsReview>();
  const [review, setReview] = useState<FrontendReleaseReview>();
  const [result, setResult] = useState<FrontendReleaseResult>();
  const [approval, setApproval] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (settingsQuery.data) setSettings(settingsQuery.data.settings);
  }, [settingsQuery.data]);
  useEffect(() => {
    setReview(undefined);
    setResult(undefined);
    setApproval("");
    setMessage("");
    setError("");
  }, [deployment, profile, region]);
  const work = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setMessage("");
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
      void historyQuery.refetch();
    }
  };
  const destination = { deployment, profile, region };
  const history = Array.isArray(historyQuery.data) ? historyQuery.data : [];
  const settingsChanged =
    !!settings &&
    !!settingsQuery.data &&
    JSON.stringify(settings) !== JSON.stringify(settingsQuery.data.settings);
  const update = (patch: Partial<FrontendReleaseSettings>) => {
    if (settings) {
      setSettings({ ...settings, ...patch });
      setSettingsReview(undefined);
    }
  };
  const approvalText = review
    ? `Publish ${review.destination.deployment} to ${review.destination.bucket}`
    : "";
  return (
    <details className={cx(statePanelClasses(), releaseDisclosureClasses)}>
      <summary className="-my-2 cursor-pointer py-2 font-semibold">
        Client environment &amp; frontend release
      </summary>
      <p className="m-0 [&+p]:mt-2">
        Generate public client settings from this deployment without starting Docker. A release then
        builds locally, reviews exact files and destination, publishes to S3, and requests
        CloudFront invalidation.
      </p>
      <p className="m-0 [&+p]:mt-2 text-caption text-graphite">
        Selected: <strong>{deployment}</strong> · {profile ?? "Choose an AWS profile"} ·{" "}
        {region ?? "Resolve the deployment region first"}. Infrastructure deployment is a separate
        operation.
      </p>
      {settingsQuery.error ? (
        <p role="alert" className="m-0 [&+p]:mt-2">
          {settingsQuery.error.message}
        </p>
      ) : null}
      {historyQuery.error ? (
        <p role="alert" className="m-0 [&+p]:mt-2">
          {historyQuery.error.message}
        </p>
      ) : null}
      {settingsChanged ? (
        <p role="status" className="m-0 [&+p]:mt-2">
          Frontend settings have unapplied changes. Review and apply their source before generating
          client env or building.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          className={buttonClasses({ variant: "quiet", size: "regular" })}
          disabled={!!busy || settingsChanged || !profile || !region}
          onClick={() =>
            void work("Generating client env…", async () => {
              const data = await call<{ file: string }>(
                "/frontend-release/environment",
                destination,
              );
              setMessage(
                `Generated ${data.file} from deployed public outputs. No containers were started.`,
              );
            })
          }
        >
          Generate / refresh client env
        </button>
        <button
          className={buttonClasses({ variant: "quiet", size: "regular" })}
          disabled={!!busy || settingsChanged || !profile || !region}
          onClick={() =>
            void work("Generating env and building…", async () => {
              setReview(undefined);
              setResult(undefined);
              setApproval("");
              const data = await call<FrontendReleaseReview>(
                "/frontend-release/build",
                destination,
              );
              setReview(data);
              setMessage("Build complete. Review publication below; no assets have been uploaded.");
            })
          }
        >
          Build &amp; review release
        </button>
      </div>
      {settings ? (
        <details className="min-w-0 [&[open]>:not(summary)]:mt-3 [&[open]>:not(summary)]:mb-0">
          <summary className="cursor-pointer py-2 font-semibold">
            Frontend project and publication settings
          </summary>
          <p className="text-caption text-graphite">
            Saved in framework-config/frontend-release.json. Choose an existing package.json script
            for Vite, Next static export, Astro, or another static frontend. Only its static output
            is published.
          </p>
          <div className="my-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-start gap-3">
            <label className={releaseFieldClasses}>
              Project directory
              <TextInput
                value={settings.projectDirectory}
                disabled={!!busy}
                onChange={(event) => update({ projectDirectory: event.target.value })}
                className="w-full"
              />
            </label>
            <label className={releaseFieldClasses}>
              Build script
              <TextInput
                value={settings.buildScript}
                disabled={!!busy}
                onChange={(event) => update({ buildScript: event.target.value })}
                className="w-full"
              />
            </label>
            <label className={releaseFieldClasses}>
              Output directory (inside project)
              <TextInput
                value={settings.outputDirectory}
                disabled={!!busy}
                onChange={(event) => update({ outputDirectory: event.target.value })}
                className="w-full"
              />
            </label>
            <label className={releaseFieldClasses}>
              Build arguments (one per line)
              <Textarea
                value={settings.buildArgs.join("\n")}
                disabled={!!busy}
                onChange={(event) =>
                  update({ buildArgs: event.target.value.split("\n").filter(Boolean) })
                }
                className="min-h-17.5 w-full"
              />
            </label>
            <label className={releaseFieldClasses}>
              Include globs (one per line)
              <Textarea
                value={settings.include.join("\n")}
                disabled={!!busy}
                onChange={(event) =>
                  update({ include: event.target.value.split("\n").filter(Boolean) })
                }
                className="min-h-17.5 w-full"
              />
            </label>
            <label className={releaseFieldClasses}>
              Exclude globs (one per line)
              <Textarea
                value={settings.exclude.join("\n")}
                disabled={!!busy}
                onChange={(event) =>
                  update({ exclude: event.target.value.split("\n").filter(Boolean) })
                }
                className="min-h-17.5 w-full"
              />
            </label>
            <label className={releaseFieldClasses}>
              Bucket prefix (blank or ending in /)
              <TextInput
                value={settings.prefix}
                disabled={!!busy}
                onChange={(event) => update({ prefix: event.target.value })}
                className="w-full"
              />
            </label>
            <label className={releaseFieldClasses}>
              CloudFront invalidation paths (one per line)
              <Textarea
                value={settings.invalidationPaths.join("\n")}
                disabled={!!busy}
                onChange={(event) =>
                  update({ invalidationPaths: event.target.value.split("\n").filter(Boolean) })
                }
                className="min-h-17.5 w-full"
              />
            </label>
            <label className="col-span-full flex min-w-0 items-start gap-2 text-label">
              <TextInput
                type="checkbox"
                checked={settings.deleteRemote}
                disabled={!!busy}
                onChange={(event) => update({ deleteRemote: event.target.checked })}
                className="mt-0.5"
              />{" "}
              Delete remote files absent from build (exact keys require review)
            </label>
          </div>
          <button
            className={buttonClasses({ variant: "quiet", size: "regular" })}
            disabled={!!busy || !settingsQuery.data}
            onClick={() =>
              void work("Reviewing settings…", async () =>
                setSettingsReview(
                  await call<FrontendSettingsReview>("/frontend-release/settings/review", {
                    settings,
                    hash: settingsQuery.data!.hash,
                  }),
                ),
              )
            }
          >
            Review settings source
          </button>
          {settingsReview ? (
            <section
              aria-label="Frontend settings source review"
              className="[&>*+*]:mt-3 [&>*+*]:mb-0"
            >
              <h4>{settingsReview.file}</h4>
              <p>Before</p>
              <pre className={releasePreClasses}>{settingsReview.before}</pre>
              <p>After</p>
              <pre className={releasePreClasses}>{settingsReview.after}</pre>
              <button
                className={buttonClasses({ variant: "quiet", size: "regular" })}
                disabled={!!busy}
                onClick={() =>
                  void work("Saving settings…", async () => {
                    await call("/frontend-release/settings/apply", { id: settingsReview.id });
                    setSettingsReview(undefined);
                    setReview(undefined);
                    await settingsQuery.refetch();
                    setMessage(
                      "Frontend settings source saved. Build and publication remain separate.",
                    );
                  })
                }
              >
                Apply settings source
              </button>
            </section>
          ) : null}
        </details>
      ) : null}
      {busy ? (
        <p role="status" className="m-0 [&+p]:mt-2">
          {busy}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="m-0 [&+p]:mt-2">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 [&+p]:mt-2">
          {error}
        </p>
      ) : null}
      {review ? (
        <section aria-label="Frontend publication review" className="[&>*+*]:mt-3 [&>*+*]:mb-0">
          <h4>Review frontend publication</h4>
          <dl className={factsClasses}>
            <dt className="text-graphite">Destination</dt>
            <dd className="m-0 wrap-anywhere">
              {review.destination.account} · {review.destination.region} · {review.destination.mode}{" "}
              · s3://{review.destination.bucket}/{review.settings.prefix}
            </dd>
            <dt className="text-graphite">Public env</dt>
            <dd className="m-0 wrap-anywhere">{review.environmentFile}</dd>
            <dt className="text-graphite">CloudFront</dt>
            <dd className="m-0 wrap-anywhere">
              {review.destination.distribution}: {review.settings.invalidationPaths.join(", ")}
            </dd>
            <dt className="text-graphite">Expires</dt>
            <dd className="m-0 wrap-anywhere">{new Date(review.expiresAt).toLocaleTimeString()}</dd>
          </dl>
          {review.warnings.map((warning) => (
            <p className="text-caption" key={warning}>
              {warning}
            </p>
          ))}
          <details className="min-w-0 [&[open]>:not(summary)]:mt-3 [&[open]>:not(summary)]:mb-0">
            <summary className="cursor-pointer py-2 font-semibold">
              Artifact manifest ({review.files.length} files)
            </summary>
            <ul>
              {review.files.map((file) => (
                <li key={file.path}>
                  <code className="wrap-anywhere">{file.path}</code> · {file.bytes} bytes ·{" "}
                  <code className="wrap-anywhere">{file.sha256}</code>
                </li>
              ))}
            </ul>
          </details>
          {review.deleteKeys.length ? (
            <details className="min-w-0 [&[open]>:not(summary)]:mt-3 [&[open]>:not(summary)]:mb-0">
              <summary className="cursor-pointer py-2 font-semibold">
                Delete {review.deleteKeys.length} remote objects
              </summary>
              <pre className={releasePreClasses}>{review.deleteKeys.join("\n")}</pre>
            </details>
          ) : null}
          <label className={releaseFieldClasses}>
            Type <code className="wrap-anywhere">{approvalText}</code>
            <TextInput
              aria-label="Frontend publication approval"
              value={approval}
              disabled={!!busy || result?.phase === "complete"}
              onChange={(event) => setApproval(event.target.value)}
              autoComplete="off"
              className="w-full"
            />
          </label>
          <button
            className={buttonClasses({ variant: "quiet", size: "regular", tone: "danger" })}
            disabled={!!busy || approval !== approvalText || result?.phase === "complete"}
            onClick={() =>
              void work("Publishing reviewed assets and invalidating CloudFront…", async () => {
                try {
                  setResult(
                    await call<FrontendReleaseResult>("/frontend-release/publish", {
                      id: review.id,
                      approval,
                    }),
                  );
                } finally {
                  setResult(
                    await call<FrontendReleaseResult>(`/frontend-release/results/${review.id}`),
                  );
                }
              })
            }
          >
            {result?.phase === "failed"
              ? "Retry reviewed release"
              : "Publish assets & request invalidation"}
          </button>
          {result ? (
            <p role="status">
              {result.phase}: {result.message} Confirmed uploads: {result.uploaded.length};
              deletions: {result.deleted.length}.
            </p>
          ) : null}
        </section>
      ) : null}
      {history.some((entry) => entry.review.destination.deployment === deployment) ? (
        <details className="min-w-0 [&[open]>:not(summary)]:mt-3 [&[open]>:not(summary)]:mb-0">
          <summary className="cursor-pointer py-2 font-semibold">
            Recent frontend release outcomes
          </summary>
          <p className="text-caption text-graphite">
            Saved results survive Studio restarts. An uploading/deleting/invalidating phase from an
            earlier process has an uncertain outcome; inspect AWS before creating a new review. Old
            session reviews cannot be resumed automatically.
          </p>
          {history
            .filter((entry) => entry.review.destination.deployment === deployment)
            .map((entry) => (
              <p className="text-caption" key={entry.review.id}>
                {entry.review.createdAt} · {entry.result.phase} · {entry.result.message} Confirmed
                uploads: {entry.result.uploaded.length}; deletions: {entry.result.deleted.length}.
              </p>
            ))}
        </details>
      ) : null}
    </details>
  );
}

export function DeploymentIdentities({
  account,
  region,
  onCreated,
}: {
  account?: string;
  region?: string;
  onCreated: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["deployment-identities"],
    queryFn: () =>
      call<{ hash: string; authority: string; targets: { name: string; mode: string }[] }>(
        "/frontend-release/identities",
      ),
  });
  const [input, setInput] = useState<DeploymentIdentityRequest>({
    mode: "dev",
    name: "",
    account: account ?? "",
    region: region ?? "us-east-1",
  });
  const [review, setReview] = useState<DeploymentIdentityReview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setInput((current) => ({
      ...current,
      account: current.account || account || "",
      region: region ?? current.region,
    }));
  }, [account, region]);
  const change = (patch: Partial<DeploymentIdentityRequest>) => {
    setInput({ ...input, ...patch });
    setReview(undefined);
  };
  const work = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className={cx(statePanelClasses(), releaseDisclosureClasses)}>
      <summary className="-my-2 cursor-pointer py-2 font-semibold">
        Development &amp; production deployment names
      </summary>
      <p className="m-0 [&+p]:mt-2">{query.data?.authority}</p>
      <p className="m-0 [&+p]:mt-2 text-caption">
        Existing targets:{" "}
        {query.data?.targets?.map((target) => `${target.name} (${target.mode})`).join(", ") ||
          "none"}
        .
      </p>
      <p className="m-0 [&+p]:mt-2">
        Create a separate deployment identity below. Applying source does not rename, replace,
        deploy or adopt existing AWS resources. Prod-mode staging is another named production
        target.
      </p>
      <div className="my-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-start gap-3">
        <label className={releaseFieldClasses}>
          Environment
          <Select
            value={input.mode}
            disabled={busy}
            onChange={(event) => change({ mode: event.target.value as "dev" | "prod" })}
            className="w-full"
          >
            <option value="dev">Development</option>
            <option value="prod">Production / staging</option>
          </Select>
        </label>
        <label className={releaseFieldClasses}>
          New deployment name
          <TextInput
            value={input.name}
            disabled={busy}
            placeholder="my-app-dev"
            onChange={(event) => change({ name: event.target.value })}
            className="w-full"
          />
        </label>
        <label className={releaseFieldClasses}>
          Account
          <TextInput
            value={input.account}
            disabled={busy}
            onChange={(event) => change({ account: event.target.value })}
            className="w-full"
          />
        </label>
        <label className={releaseFieldClasses}>
          Region
          <TextInput
            value={input.region}
            disabled={busy}
            onChange={(event) => change({ region: event.target.value })}
            className="w-full"
          />
        </label>
      </div>
      <button
        className={buttonClasses({ variant: "quiet", size: "regular" })}
        disabled={busy || !query.data}
        onClick={() =>
          void work(async () =>
            setReview(
              await call<DeploymentIdentityReview>("/frontend-release/identities/review", {
                identity: input,
                hash: query.data!.hash,
              }),
            ),
          )
        }
      >
        Review new deployment source
      </button>
      {query.error ? (
        <p role="alert" className="m-0 [&+p]:mt-2">
          {query.error.message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 [&+p]:mt-2">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="m-0 [&+p]:mt-2">
          {message}
        </p>
      ) : null}
      {review ? (
        <section
          aria-label="Deployment identity source review"
          className="[&>*+*]:mt-3 [&>*+*]:mb-0"
        >
          {review.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {review.changes.map((file) => (
            <details
              key={file.file}
              open
              className="min-w-0 [&[open]>:not(summary)]:mt-3 [&[open]>:not(summary)]:mb-0"
            >
              <summary className="cursor-pointer py-2 font-semibold">{file.file}</summary>
              <p>Before</p>
              <pre className={releasePreClasses}>{file.before}</pre>
              <p>After</p>
              <pre className={releasePreClasses}>{file.after}</pre>
            </details>
          ))}
          <button
            className={buttonClasses({ variant: "quiet", size: "regular" })}
            disabled={busy}
            onClick={() =>
              void work(async () => {
                const result = await call<{ name: string; message: string }>(
                  "/frontend-release/identities/apply",
                  { id: review.id },
                );
                setMessage(result.message);
                setReview(undefined);
                await query.refetch();
                await queryClient.invalidateQueries({ queryKey: ["deploy", "overview"] });
                onCreated(result.name);
              })
            }
          >
            Apply new deployment source
          </button>
        </section>
      ) : null}
    </details>
  );
}
