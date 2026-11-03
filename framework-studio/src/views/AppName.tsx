import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { Pencil, X } from "lucide-react";
import { sourceDiff } from "../../shared/source-diff";
import { SourceDiff } from "./SourceDiff";
import { appNamePreview, type AppNameReview, type AppNameRow, type AppNameView } from "../../shared/app-name";
import { ApiError, call } from "../http";
import { inspectorHelpClasses, inspectorNoteClasses } from "../inspector-ui";
import { useStudio } from "../studio";
import { Button } from "../ui/Button";
import { cx } from "../ui/classes";
import { TextInput } from "../ui/FormControls";
import { IconButton } from "../ui/IconButton";

const WIDTH = 380;

/** A stage's mode, as the CDK environment inspector labels one: a dot and Dev or Prod in its color. */
function ModeLabel({ mode }: { readonly mode: "dev" | "prod" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-[5px] text-meta font-semibold leading-[1.5] before:size-1.5 before:flex-none before:rounded-full before:bg-current before:content-['']",
        mode === "dev" ? "text-dev" : "text-prod",
      )}
    >
      {mode === "dev" ? "Dev" : "Prod"}
    </span>
  );
}

/** What a row says beyond its stage. Nothing is claimed about AWS until a review has looked. */
function caption(row: AppNameRow, legacy: boolean, unchanged: boolean, reviewed: boolean): string | undefined {
  if (row.outcome === "keeps") {
    if (row.check === "deployed") return "Deployed as this name · keeps it";
    return legacy ? "Keeps its name" : "Deploys as this name whatever the app is called";
  }
  // Before a new name is typed, or when only the id is added, the name is all there is to say.
  if (unchanged || (row.before && row.before === row.after)) return undefined;
  if (row.check === "deployed") return `Deployed as ${row.deployed} · the new name is a new deployment`;
  if (row.check === "absent") return "Not deployed · follows the new name";
  if (row.check === "unknown") return "Couldn't check AWS · follows the new name";
  if (row.mode === "prod" && row.before && !reviewed) return "Checked in AWS when you review";
  return legacy || !row.before ? "Deploys as this name" : "Follows the new name";
}

function Rows({
  rows,
  legacy,
  unchanged = false,
  reviewed = false,
}: {
  readonly rows: readonly AppNameRow[];
  readonly legacy: boolean;
  readonly unchanged?: boolean;
  readonly reviewed?: boolean;
}) {
  return (
    <ul className="m-0 grid list-none p-0" aria-label="Deployments">
      {rows.map((row) => (
        <li
          key={row.stage}
          data-stage={row.stage}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-rule py-2.5 first:pt-0 last:border-b-0 last:pb-0"
        >
          <code className="min-w-0 text-caption wrap-anywhere">
            {row.before && row.before !== row.after && !unchanged ? `${row.before} → ${row.after || "…"}` : row.after || "…"}
          </code>
          <ModeLabel mode={row.mode} />
          <span className="col-span-full text-caption text-graphite">
            {[`${row.stage} stage`, caption(row, legacy, unchanged, reviewed)].filter(Boolean).join(" · ")}
          </span>
          {row.reason ? <span className="col-span-full text-caption text-graphite wrap-anywhere">{row.reason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** A reviewed cdk-app/cdk.json change to how stages are named: the deployments, the consequences, and the edit. */
export function AppNameChange({ review, legacy = false }: { readonly review: AppNameReview; readonly legacy?: boolean }) {
  return (
    <>
      <Rows rows={review.rows} legacy={legacy} reviewed />
      <ul className="m-0 grid list-none gap-2 p-0">
        {review.warnings.map((warning) => (
          <li key={warning} className={inspectorNoteClasses}>
            {warning}
          </li>
        ))}
      </ul>
      <SourceDiff file={review.change.file} lines={sourceDiff(review.change.file, review.change.before, review.change.after).lines} />
    </>
  );
}

/**
 * The app's name in the navbar, and its editor. The name is framework:app in
 * cdk-app/cdk.json, from which every stage deploys as `<app>-<stage>`; it names
 * deployments and never selects an AWS destination.
 */
export function AppNameMenu() {
  const { snapshot, awsProfiles } = useStudio();
  const application = snapshot.application;
  const queryClient = useQueryClient();
  const id = useId();
  const titleId = useId();
  const helpId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [name, setName] = useState("");
  const [review, setReview] = useState<AppNameReview>();
  const [error, setError] = useState<{ message: string; stale: boolean }>();
  const [busy, setBusy] = useState(false);
  const view = useQuery({
    queryKey: ["app-name"],
    queryFn: () => call<AppNameView>("/app-name"),
    enabled: open,
    staleTime: 0,
  });
  const label = application?.name ?? (application?.legacy ? "Name this app" : "Fix app name");
  // A name with no id still names deployments, but the CLI refuses to deploy until the id exists.
  const attention = !!application?.problem;
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => {
    panel.current?.hidePopover?.();
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ top: rect.bottom + 8, left: Math.max(12, Math.min(rect.left, window.innerWidth - WIDTH - 12)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  // Opening selects the name, so typing replaces it.
  useEffect(() => {
    if (!open || !view.data || review) return;
    window.requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.select();
    });
  }, [open, view.data, review]);

  const reset = () => {
    setName(application?.name ?? "");
    setReview(undefined);
    setError(undefined);
  };
  const preview = view.data ? appNamePreview(view.data, name) : undefined;
  const invalid = !!name.trim() && !!preview?.problems.length;
  // An unchanged name is reviewable only to add the missing id.
  const reviewable = !!preview && !preview.problems.length && (!preview.unchanged || !!view.data?.needsId);
  const work = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError({
        message: reason instanceof Error ? reason.message : String(reason),
        stale: reason instanceof ApiError && reason.status === 409,
      });
    } finally {
      setBusy(false);
    }
  };
  // The review looks in AWS with the profiles each mode already uses; nothing is written until Apply.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!view.data || !reviewable) return;
    void work(async () => {
      setReview(await call<AppNameReview>("/app-name/review", { name: name.trim(), hash: view.data!.hash, profiles: awsProfiles }));
      window.requestAnimationFrame(() => reviewHeading.current?.focus());
    });
  };
  const apply = () =>
    void work(async () => {
      await call<{ name: string }>("/app-name/apply", { id: review!.id });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["app-name"] }),
        queryClient.invalidateQueries({ queryKey: ["deploy", "overview"] }),
        queryClient.invalidateQueries({ queryKey: ["deployment-identities"] }),
      ]);
      panel.current?.hidePopover?.();
    });

  // A snapshot without the field comes from an older server, which cannot rename the app.
  if (!application) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        aria-label={application?.name ? `App name: ${application.name}. ${attention ? "Needs attention" : "Rename"}` : label}
        title="Rename app"
        data-ui="app-name"
        className={cx(
          "group ml-1 inline-flex min-h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 align-middle font-sans text-step-minus1 font-normal hover:bg-wash hover:text-ink",
          attention ? "text-refuse" : "text-graphite",
        )}
      >
        <span className="max-w-[180px] truncate vp-1200:hidden vp-760:inline">{label}</span>
        {/* Shown on hover, focus and while open; kept in place so the bar never shifts. Between 761 and
            1200px it stands alone for the hidden name, and touch screens, which cannot hover, always show it. */}
        <Pencil
          size={12}
          className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-aria-expanded:opacity-100 vp-1200:opacity-100 vp-760:opacity-0 vp-760:group-hover:opacity-100 vp-760:group-focus-visible:opacity-100 vp-760:group-aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
          aria-hidden
        />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-labelledby={titleId}
        onToggle={(event) => {
          // React relays a nested <details>' toggle here too; only the popover's own counts.
          if (event.target !== event.currentTarget) return;
          const opened = event.newState === "open";
          setOpen(opened);
          if (opened) reset();
          else window.requestAnimationFrame(() => {
            if (!panel.current?.contains(document.activeElement) && document.activeElement === document.body) trigger.current?.focus();
          });
        }}
        style={{ top: position.top, left: position.left, maxHeight: `calc(100dvh - ${position.top + 12}px)` }}
        className="fixed right-auto bottom-auto z-30 m-0 w-[380px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-lg border border-rule-strong bg-sheet p-0 text-left font-sans text-body font-normal tracking-normal whitespace-normal text-ink shadow-popover"
      >
        <header className="flex items-center justify-between gap-4 border-b border-rule px-4 py-3">
          <div className="grid min-w-0 gap-1">
            <span className="text-caption text-graphite">{review ? "Review" : "App"}</span>
            <h2
              id={titleId}
              ref={reviewHeading}
              tabIndex={-1}
              className="m-0 text-body font-semibold wrap-anywhere"
            >
              {review
                ? review.from
                  ? review.from === review.name
                    ? review.name
                    : `${review.from} → ${review.name}`
                  : `Name this app ${review.name}`
                : application?.name ?? "Name this app"}
            </h2>
          </div>
          <IconButton variant="quiet" aria-label="Close app name" onClick={() => panel.current?.hidePopover?.()}>
            <X size={15} aria-hidden />
          </IconButton>
        </header>
        {open ? (
          <div className="grid gap-4 p-4">
            {view.isPending ? (
              <p role="status" className={inspectorNoteClasses}>
                Reading cdk-app/cdk.json…
              </p>
            ) : view.isError ? (
              <p role="alert" className="m-0 text-caption text-refuse wrap-anywhere">
                {view.error.message}
              </p>
            ) : review ? (
              <>
                <AppNameChange review={review} legacy={!review.from} />
                {error ? (
                  <p role="alert" className="m-0 text-caption text-refuse wrap-anywhere">
                    {error.message}
                  </p>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => {
                      setReview(undefined);
                      setError(undefined);
                    }}
                  >
                    Back
                  </Button>
                  <Button variant="primary" disabled={busy} onClick={apply}>
                    Apply
                  </Button>
                </div>
              </>
            ) : view.data && ((!view.data.name && !view.data.legacy) || (!view.data.appId && !view.data.needsId)) ? (
              <p role="alert" className="m-0 text-caption text-refuse wrap-anywhere">
                {view.data.problem} Fix it in cdk-app/cdk.json, then rename the app here.
              </p>
            ) : view.data && preview ? (
              <form className="grid gap-4" onSubmit={submit}>
                <div className="grid min-w-0 gap-1">
                  <label htmlFor={`${id}-name`} className="text-label font-medium">
                    Name
                  </label>
                  <TextInput
                    ref={field}
                    id={`${id}-name`}
                    controlSize="panel"
                    value={name}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={invalid || undefined}
                    aria-describedby={helpId}
                    onChange={(event) => {
                      setName(event.target.value);
                      setError(undefined);
                    }}
                  />
                  <p id={helpId} className={cx("m-0", inspectorHelpClasses)}>
                    Lowercase letters, numbers and hyphens. Deployments are named name-stage.
                  </p>
                  {invalid ? (
                    <p role="alert" className="m-0 text-caption text-refuse wrap-anywhere">
                      {preview.problems[0]}
                    </p>
                  ) : null}
                </div>
                <section className="grid gap-2" aria-labelledby={`${id}-deployments`}>
                  <h3 id={`${id}-deployments`} className="m-0 text-label font-semibold">
                    Deployments
                  </h3>
                  <Rows
                    rows={preview.rows}
                    legacy={!!view.data.legacy}
                    unchanged={preview.unchanged}
                  />
                </section>
                {view.data.needsId && !view.data.legacy ? (
                  <p className={inspectorNoteClasses}>
                    This app has no permanent id yet, so it can't be deployed. Review adds one.
                  </p>
                ) : null}
                {error ? (
                  <div className="grid justify-items-start gap-2">
                    <p role="alert" className="m-0 text-caption text-refuse wrap-anywhere">
                      {error.stale ? "cdk-app/cdk.json changed. Review again." : error.message}
                    </p>
                    {error.stale ? (
                      <Button
                        variant="quiet"
                        size="compact"
                        onClick={() => {
                          setError(undefined);
                          void view.refetch();
                        }}
                      >
                        Reload
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="quiet" type="button" disabled={busy} onClick={() => panel.current?.hidePopover?.()}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={busy || !reviewable}
                  >
                    Review
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
