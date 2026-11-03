import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, Plus, RefreshCw, TriangleAlert, Trash2, X } from "lucide-react";
import {
  dialogClasses,
  dialogHeaderClasses,
  dialogTitleClasses,
  inspectorContentClasses,
  inspectorContextClasses,
  inspectorNoteClasses,
} from "../inspector-ui";
import { cx } from "../ui/classes";
import { IconButton } from "../ui/IconButton";
import { Button } from "../ui/Button";
import { Select } from "../ui/FormControls";
import { useStudio } from "../studio";
import {
  awsProfileCatalogQuery,
  awsProfileIdentityQuery,
  checkAwsProfile,
  connectionStateLabels,
  effectiveProfileKind,
  profileMethodLabels,
} from "../aws-profile-queries";
import {
  awsConnectionsApi,
  authenticationFinished,
  type AuthenticationRequest,
  type AuthenticationSession,
  type LogoutReview,
  type ProfileReview,
  type ProfileDeletionReview,
} from "../aws-connections-api";
import type { AwsCliCapabilities, AwsEditableFields } from "../../shared/aws-connection-management";
import type {
  AwsConnectionObservation,
  AwsProfileCatalog,
  AwsProfileDescriptor,
} from "../../shared/aws-connections";
import { AddProfile } from "./AwsProfileForms";
import { AwsProfileDetails } from "./AwsProfileDetails";
import { AuthenticationProgress } from "./AwsProfileAuthentication";
import { EnvironmentPills } from "./DeploymentBadge";
import type { Mode } from "../../shared/model";
import {
  ProfileChangeReview,
  ProfileDeletionReview as ProfileDeletionConfirmation,
  ProfileLogoutReview,
} from "./AwsProfileReviews";

const MODE_NAMES = { dev: "Development", prod: "Production" } as const;
/** Master-list rows: the Resource browser's two-line grammar, selected with the shared wash and rule. */
const profileRowClasses =
  "group/profile grid min-h-[52px] w-full min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] content-center items-center gap-x-2 gap-y-0.5 rounded-md border border-transparent bg-transparent py-1.5 pr-10 pl-2.5 text-left font-[inherit] text-ink enabled:hover:bg-wash aria-[current=true]:border-rule aria-[current=true]:bg-wash disabled:cursor-default disabled:opacity-55";
const backClasses =
  "-ml-2 inline-flex min-h-(--control-height-sm) min-w-0 cursor-pointer items-center gap-0.5 rounded-md border-0 bg-transparent py-0 pr-2 pl-1 font-sans text-label leading-none font-semibold text-ink hover:bg-wash disabled:cursor-not-allowed disabled:opacity-45 coarse:min-h-11";

/** Supporting text reads in ink on a washed (hovered or selected) row, keeping 4.5:1 in the light theme. */
const rowSupportClasses =
  "text-graphite group-hover/profile:text-ink group-aria-[current=true]/profile:text-ink";

/** Only exceptions get labels: a verified or failing check marks the row; an unchecked one stays quiet. */
function profileHealth(
  profile: AwsProfileDescriptor,
  observation: AwsConnectionObservation | undefined,
): { readonly state: AwsConnectionObservation["state"]; readonly attention: boolean } {
  const state =
    observation?.state ??
    (profile.diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? "configuration-error"
      : "unchecked");
  return {
    state,
    attention: state === "needs-auth" || state === "configuration-error" || state === "unavailable",
  };
}

export function AwsProfileConfiguration({ onClose }: { readonly onClose: () => void }) {
  const { awsProfile, awsProfiles, setAwsProfile, live, mode: activeMode } = useStudio();
  const queryClient = useQueryClient();
  const catalog = useQuery(awsProfileCatalogQuery());
  const capabilities = (
    catalog.data as (AwsProfileCatalog & { capabilities?: AwsCliCapabilities }) | undefined
  )?.capabilities;
  const [selectedName, setSelectedName] = useState(awsProfile ?? "");
  const [adding, setAdding] = useState(false);
  const [addingName, setAddingName] = useState<string>();
  const [detailVisible, setDetailVisible] = useState(Boolean(awsProfile));
  const [busy, setBusy] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [review, setReview] = useState<ProfileReview>();
  const [logoutReview, setLogoutReview] = useState<LogoutReview>();
  const [deletionReview, setDeletionReview] = useState<ProfileDeletionReview>();
  const [authentication, setAuthentication] = useState<AuthenticationSession>();
  const [authenticationRequest, setAuthenticationRequest] = useState<AuthenticationRequest>();
  const [accounts, setAccounts] = useState<readonly { accountId: string; accountName?: string }[]>(
    [],
  );
  const [roles, setRoles] = useState<readonly { roleName: string }[]>([]);
  const [account, setAccount] = useState("");
  const [role, setRole] = useState("");
  const [checks, setChecks] = useState<Record<string, AwsConnectionObservation>>({});
  const mounted = useRef(true);
  const refreshingRef = useRef(false);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const detailScroll = useRef<HTMLElement>(null);
  const profileList = useRef<HTMLUListElement>(null);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const loadedAccounts = useRef("");
  const currentAuthentication = useRef(authentication);
  currentAuthentication.current = authentication;
  const currentAssociations = useRef(awsProfiles);
  currentAssociations.current = awsProfiles;
  const currentRequest = useRef(authenticationRequest);
  currentRequest.current = authenticationRequest;
  /** A finished sign-in with no further step returns to the view it began from; the status line keeps its outcome. */
  const receive = (session: AuthenticationSession) => {
    const followUp =
      session.state === "complete" &&
      (currentRequest.current?.method === "sso" || !!session.reviewRequired);
    if (!authenticationFinished(session) || followUp) {
      setAuthentication(session);
      return;
    }
    setAuthentication(undefined);
    if (session.state === "failed") setError(session.message);
    else setMessage(session.message);
    // Reconnecting an existing profile is confirmed by checking it, so its state reflects the sign-in.
    const profile = currentRequest.current?.profile;
    if (session.state === "complete" && profile) void check(profile).catch(() => {});
  };
  const profile = catalog.data?.profiles.find((item) => item.name === selectedName);
  const defaultUnconfigured = !!catalog.data && !catalog.data.profiles.some((item) => item.name === "default");
  useEffect(() => {
    setChecks({});
    setReview(undefined);
    setLogoutReview(undefined);
    setDeletionReview(undefined);
  }, [live.awsConnectionRevision]);
  // The modal reads cached observations. Choosing a row never executes a credential provider.
  const observation = useQuery({
    ...awsProfileIdentityQuery(profile?.name),
    enabled: false,
  });
  const authActive = !!authentication && !authenticationFinished(authentication);
  const pending = !!busy || authActive;
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    mounted.current = true;
    element.showModal();
    return () => {
      mounted.current = false;
      element.close();
      const active = currentAuthentication.current;
      if (active && !authenticationFinished(active))
        void awsConnectionsApi.cancel(active.id).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!authentication || authenticationFinished(authentication)) return;
    const controller = new AbortController();
    let active = true;
    const poll = async () => {
      try {
        const next = await awsConnectionsApi.authentication(authentication.id, controller.signal);
        if (!active) return;
        receive(next);
        if (authenticationFinished(next))
          void queryClient.invalidateQueries({ queryKey: ["aws-connections"] });
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "Could not refresh sign-in progress.",
          );
      }
    };
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [authentication?.id, authentication?.state, queryClient]);
  useEffect(() => {
    if (
      authentication?.state !== "complete" ||
      authenticationRequest?.method !== "sso" ||
      loadedAccounts.current === authentication.id
    )
      return;
    loadedAccounts.current = authentication.id;
    const controller = new AbortController();
    setBusy("Loading assigned AWS accounts…");
    void awsConnectionsApi
      .accounts(authentication.id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setAccounts(next.accounts);
        if (!next.accounts.length)
          setMessage(
            "No AWS accounts are assigned to this session. Ask your administrator for an account assignment.",
          );
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Could not load assigned accounts.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy("");
      });
    return () => controller.abort();
  }, [authentication?.id, authentication?.state, authenticationRequest?.method]);
  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The connection action could not finish.",
      );
    } finally {
      setBusy("");
    }
  };
  const refreshCatalog = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["aws-connections"],
      refetchType: "none",
    });
    await catalog.refetch({ throwOnError: true });
  };
  const refresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError("");
    setMessage("");
    const [result] = await Promise.allSettled([
      refreshCatalog(),
      new Promise<void>((resolve) => window.setTimeout(resolve, 1000)),
    ]);
    if (!mounted.current) return;
    if (result.status === "rejected")
      setError(
        result.reason instanceof Error ? result.reason.message : "Could not refresh AWS profiles.",
      );
    refreshingRef.current = false;
    setRefreshing(false);
  };
  const check = async (name: string, signal?: AbortSignal) => {
    const next = await checkAwsProfile(name, signal);
    queryClient.setQueryData(awsProfileIdentityQuery(name).queryKey, next);
    setChecks((current) => ({ ...current, [name]: next }));
  };
  const authenticate = (request: AuthenticationRequest) =>
    void run("Starting sign-in…", async () => {
      setReview(undefined);
      setLogoutReview(undefined);
      setDeletionReview(undefined);
      setAuthenticationRequest(request);
      currentRequest.current = request;
      setAccounts([]);
      setRoles([]);
      setAccount("");
      setRole("");
      receive(await awsConnectionsApi.authenticate(request));
    });
  const reviewFields = (
    name: string,
    fields: AwsEditableFields,
    create: boolean,
    authenticationId?: string,
  ) =>
    void run("Preparing review…", async () => {
      setReview(
        await awsConnectionsApi.review({
          name,
          fields,
          create,
          ...(authenticationId ? { authenticationId } : {}),
        }),
      );
    });
  const chooseAccount = (value: string) => {
    setAccount(value);
    setRole("");
    setRoles([]);
    if (value && authentication)
      void run("Loading permission sets…", async () =>
        setRoles((await awsConnectionsApi.roles(authentication.id, value)).roles),
      );
  };
  const close = () => {
    if (busy) return;
    dialog.current?.close();
    onClose();
  };
  const focusDetailsWhenTriggerHidden = (trigger: HTMLElement) => {
    window.requestAnimationFrame(() => {
      if (trigger.isConnected && trigger.getClientRects().length) return;
      detailScroll.current?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    });
  };
  const chooseProfile = (name: string, trigger?: HTMLElement) => {
    setSelectedName(name);
    setDetailVisible(true);
    setAdding(false);
    setReview(undefined);
    setLogoutReview(undefined);
    setDeletionReview(undefined);
    setError("");
    setMessage("");
    if (!authActive) setAuthentication(undefined);
    detailScroll.current?.scrollTo({ top: 0 });
    if (trigger) focusDetailsWhenTriggerHidden(trigger);
  };
  const addProfile = (trigger: HTMLElement, name?: string) => {
    setAdding(true);
    setAddingName(name);
    if (name) setSelectedName(name);
    setDetailVisible(true);
    setAuthentication(undefined);
    setReview(undefined);
    setLogoutReview(undefined);
    setDeletionReview(undefined);
    setError("");
    setMessage("");
    detailScroll.current?.scrollTo({ top: 0 });
    focusDetailsWhenTriggerHidden(trigger);
  };
  const showProfiles = () => {
    setDetailVisible(false);
    window.requestAnimationFrame(() => {
      const selected = profileList.current?.querySelector<HTMLButtonElement>(
        'button[aria-current="true"]',
      );
      (selected ?? addTrigger.current)?.focus();
    });
  };
  const restoreDeleteFocus = () => {
    if (deleteTrigger.current?.isConnected && !deleteTrigger.current.getClientRects().length)
      setDetailVisible(false);
    window.requestAnimationFrame(() => {
      const trigger = deleteTrigger.current;
      if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus();
      else detailScroll.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
  };
  const cancelDeletion = () => {
    if (!deletionReview || busy) return;
    void run("Discarding deletion review…", async () => {
      await awsConnectionsApi.discard(deletionReview.id);
      setDeletionReview(undefined);
      restoreDeleteFocus();
    });
  };
  /** Selects the profile for exactly these modes; a mode it leaves keeps no profile, never another. */
  const associate = (name: string, modes: readonly Mode[]) => {
    for (const mode of ["dev", "prod"] as const) {
      const current = currentAssociations.current[mode] === name;
      if (modes.includes(mode) && !current) {
        setAwsProfile(mode, name);
        if (mode === activeMode)
          void queryClient.fetchQuery(awsProfileIdentityQuery(name)).catch(() => {});
      } else if (!modes.includes(mode) && current) setAwsProfile(mode, undefined);
    }
    setMessage(
      modes.length
        ? `${name} is selected for ${modes.map((mode) => MODE_NAMES[mode]).join(" and ")}.`
        : `${name} is not selected for Development or Production.`,
    );
  };
  const deleteProfile = () =>
    void run("Deleting profile…", async () => {
      if (!deletionReview) return;
      const result = await awsConnectionsApi.deleteProfile(deletionReview.id);
      for (const mode of ["dev", "prod"] as const)
        if (currentAssociations.current[mode] === result.name) setAwsProfile(mode, undefined);
      setDeletionReview(undefined);
      setSelectedName("");
      setDetailVisible(false);
      setAuthentication(undefined);
      setAdding(false);
      setChecks((current) => {
        const next = { ...current };
        delete next[result.name];
        return next;
      });
      queryClient.removeQueries({ queryKey: awsProfileIdentityQuery(result.name).queryKey });
      setMessage(
        result.name === "default" ? "Default profile cleared." : `Deleted profile ${result.name}.`,
      );
      try {
        await refreshCatalog();
      } catch {
        setError(
          "The profile was deleted, but the profile list could not refresh. Refresh the list to try again.",
        );
      }
      window.requestAnimationFrame(() => {
        if (addTrigger.current?.getClientRects().length) addTrigger.current.focus();
        else detailScroll.current?.querySelector<HTMLButtonElement>("button")?.focus();
      });
    });
  const environment = catalog.data?.environment;
  // A review or sign-in replaces the profile view; the view stays mounted so Back restores its fields.
  const flowOpen = !!deletionReview || !!review || !!logoutReview || !!authentication;
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className={dialogClasses({
        size: "regular",
        className: "h-[min(760px,calc(100dvh-48px))]",
      })}
      onCancel={(event) => {
        event.preventDefault();
        if (deletionReview) cancelDeletion();
        else close();
      }}
    >
      <header className={cx(dialogHeaderClasses, "flex items-center justify-between gap-4")}>
        <h2 id={titleId} className={dialogTitleClasses}>
          AWS profile configuration
        </h2>
        <IconButton
          autoFocus
          variant="quiet"
          disabled={!!busy}
          aria-label="Close AWS profile configuration"
          onClick={close}
        >
          <X size={16} aria-hidden />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {catalog.isPending ? (
          <p role="status" className={cx(inspectorNoteClasses, "px-5 py-4")}>
            Loading AWS profiles…
          </p>
        ) : catalog.isError && !catalog.data ? (
          <div className="grid justify-items-start gap-2 px-5 py-4">
            <p role="alert" className="m-0 text-label text-refuse wrap-anywhere">
              Could not load AWS profiles. {catalog.error.message}
            </p>
            <Button variant="quiet" onClick={() => void catalog.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {catalog.data ? (
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[272px_minmax(0,1fr)] vp-760:grid-cols-1">
            <aside
              aria-label="Configured AWS profiles"
              className={cx(
                "flex min-h-0 min-w-0 flex-col gap-3 py-4 pr-3 pl-4 vp-760:pr-4",
                detailVisible && "vp-760:hidden",
              )}
            >
              <div className="flex flex-none flex-wrap gap-2 px-1">
                <Button
                  ref={addTrigger}
                  size="compact"
                  disabled={pending}
                  onClick={(event) => addProfile(event.currentTarget)}
                >
                  <Plus size={14} aria-hidden />
                  Add profile
                </Button>
                <IconButton
                  variant="quiet"
                  size="compact"
                  disabled={pending || refreshing || catalog.isFetching}
                  data-slot="aws-profile-refresh"
                  aria-label="Refresh AWS profiles"
                  aria-busy={refreshing}
                  onClick={() => void refresh()}
                >
                  <RefreshCw
                    size={14}
                    aria-hidden
                    className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined}
                  />
                </IconButton>
              </div>
              {!catalog.data.profiles.length ? (
                <p className={cx(inspectorNoteClasses, "px-1")}>
                  No AWS profiles yet. Add a profile to connect your first account.
                </p>
              ) : null}
              <ul
                ref={profileList}
                className="m-0 grid min-h-0 flex-1 list-none content-start overflow-y-auto p-1 [scrollbar-gutter:stable]"
              >
                {defaultUnconfigured ? (
                  <li
                    data-slot="aws-profile-card"
                    data-profile="default"
                    className="relative border-b border-rule py-0.5 last:border-b-0"
                  >
                    <button
                      disabled={pending}
                      aria-label="Configure default AWS profile"
                      aria-current={adding && addingName === "default" ? "true" : undefined}
                      onClick={(event) => addProfile(event.currentTarget, "default")}
                      className={profileRowClasses}
                    >
                      <strong className={cx("truncate text-label font-medium", rowSupportClasses)}>
                        default
                      </strong>
                      <span className={cx("col-span-full truncate text-caption", rowSupportClasses)}>
                        Not configured · Click to configure
                      </span>
                    </button>
                  </li>
                ) : null}
                {catalog.data.profiles.map((item) => {
                  const selected = !adding && item.name === selectedName;
                  const cached =
                    checks[item.name] ??
                    queryClient.getQueryData<AwsConnectionObservation>(
                      awsProfileIdentityQuery(item.name).queryKey,
                    );
                  const { state, attention } = profileHealth(item, cached);
                  const modes = (["dev", "prod"] as const).filter(
                    (mode) => awsProfiles[mode] === item.name,
                  );
                  const method = `${profileMethodLabels[effectiveProfileKind(item, cached)]}${item.region ? ` · ${item.region}` : ""}`;
                  const spoken = [
                    state === "connected" || attention ? connectionStateLabels[state] : undefined,
                    modes.length
                      ? `selected for ${modes.map((mode) => MODE_NAMES[mode]).join(" and ")}`
                      : undefined,
                  ].filter((part) => part !== undefined);
                  return (
                    <li
                      key={item.name}
                      className="relative border-b border-rule py-0.5 last:border-b-0"
                      data-slot="aws-profile-card"
                      data-profile={item.name}
                    >
                      <button
                        disabled={pending}
                        aria-current={selected ? "true" : undefined}
                        onClick={(event) => chooseProfile(item.name, event.currentTarget)}
                        className={profileRowClasses}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <strong
                            className={cx(
                              "truncate text-label font-medium",
                              attention && "text-refuse",
                            )}
                            title={item.name}
                          >
                            {item.name}
                          </strong>
                          {state === "connected" ? (
                            <Check size={12} strokeWidth={2.5} className="shrink-0 text-accept" aria-hidden />
                          ) : attention ? (
                            <TriangleAlert size={12} strokeWidth={2.5} className="shrink-0 text-refuse" aria-hidden />
                          ) : null}
                        </span>
                        <span aria-hidden className="flex">
                          <EnvironmentPills
                            availability={{ dev: modes.includes("dev"), prod: modes.includes("prod") }}
                            enabledOnly
                            className="min-h-[calc(1.5em+4px)]"
                          />
                        </span>
                        <span
                          className={cx("col-span-full truncate text-caption", rowSupportClasses)}
                          title={method}
                        >
                          {method}
                          {/* After the method, so the row's name still begins "name method". */}
                          {spoken.length ? (
                            <span className="sr-only">· {spoken.join(" · ")}</span>
                          ) : null}
                        </span>
                      </button>
                      <IconButton
                        variant="quiet"
                        size="compact"
                        tone="danger"
                        className="absolute top-1/2 right-1 -translate-y-1/2"
                        aria-label={`Delete AWS profile ${item.name}`}
                        disabled={pending}
                        onClick={(event) => {
                          deleteTrigger.current = event.currentTarget;
                          chooseProfile(item.name);
                          void run("Preparing deletion review…", async () => {
                            setDeletionReview(await awsConnectionsApi.deleteReview(item.name));
                            detailScroll.current?.scrollTo({ top: 0 });
                          });
                        }}
                      >
                        <Trash2 size={14} aria-hidden />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
              <div className="grid flex-none gap-1 px-1">
                {capabilities ? (
                  <p
                    className={
                      capabilities.available
                        ? inspectorNoteClasses
                        : "m-0 text-caption text-refuse wrap-anywhere"
                    }
                  >
                    {capabilities.available
                      ? `AWS CLI ${capabilities.version ?? "available"}`
                      : "AWS CLI unavailable. Install AWS CLI v2 to sign in from Studio."}
                  </p>
                ) : null}
                {environment?.credentialsPresent ? (
                  <p className={inspectorNoteClasses}>
                    Credential environment variables are set. Only a profile whose credential source
                    is Environment uses them.
                  </p>
                ) : null}
                {environment?.endpointOverridesPresent ? (
                  <p className={inspectorNoteClasses}>
                    AWS endpoint overrides are set. Identity checks still use trusted AWS endpoints.
                  </p>
                ) : null}
                {catalog.data.diagnostics.map((diagnostic, index) => (
                  <p
                    key={index}
                    className={
                      diagnostic.severity === "error"
                        ? "m-0 text-caption text-refuse wrap-anywhere"
                        : inspectorNoteClasses
                    }
                  >
                    {diagnostic.message}
                  </p>
                ))}
              </div>
            </aside>
            <section
              ref={detailScroll}
              data-slot="aws-profile-detail-scroll"
              className={cx(
                inspectorContextClasses,
                inspectorContentClasses,
                "flex min-w-0 flex-col border-l border-rule vp-760:border-l-0",
                !detailVisible && "vp-760:hidden",
              )}
              aria-label="AWS profile details"
            >
              <div className="hidden flex-none border-b border-rule px-5 py-1.5 vp-760:flex">
                <button className={backClasses} disabled={pending} onClick={showProfiles}>
                  <ChevronLeft size={16} className="shrink-0 text-graphite" aria-hidden />
                  <span className="truncate">All profiles</span>
                </button>
              </div>
              {deletionReview ? (
                <ProfileDeletionConfirmation
                  review={deletionReview}
                  associations={awsProfiles}
                  pending={pending}
                  onCancel={cancelDeletion}
                  onConfirm={deleteProfile}
                />
              ) : review ? (
                <ProfileChangeReview
                  review={review}
                  pending={pending}
                  onBack={() =>
                    void run("Discarding review…", async () => {
                      await awsConnectionsApi.discard(review.id);
                      setReview(undefined);
                    })
                  }
                  onSave={() =>
                    void run("Saving profile…", async () => {
                      const result = await awsConnectionsApi.apply(review.id);
                      setReview(undefined);
                      setAuthentication(undefined);
                      setAdding(false);
                      setSelectedName(result.name);
                      setDetailVisible(true);
                      setMessage(result.message || "Profile saved.");
                      await refreshCatalog();
                      await check(result.name);
                      detailScroll.current?.scrollTo({ top: 0 });
                      window.requestAnimationFrame(() => {
                        detailScroll.current
                          ?.querySelector<HTMLElement>("h3")
                          ?.focus({ preventScroll: true });
                      });
                    })
                  }
                />
              ) : logoutReview ? (
                <ProfileLogoutReview
                  review={logoutReview}
                  pending={pending}
                  onCancel={() => setLogoutReview(undefined)}
                  onConfirm={() =>
                    void run("Signing out…", async () => {
                      const result = await awsConnectionsApi.logout(logoutReview.id);
                      setLogoutReview(undefined);
                      setMessage(result.message);
                      await refreshCatalog();
                    })
                  }
                />
              ) : authentication ? (
                <AuthenticationProgress
                  session={authentication}
                  pending={!!busy}
                  onCancel={() =>
                    void run("Canceling sign-in…", async () =>
                      receive(await awsConnectionsApi.cancel(authentication.id)),
                    )
                  }
                  onConfirm={(accepted) =>
                    void run("Confirming identity…", async () =>
                      receive(await awsConnectionsApi.confirm(authentication.id, accepted)),
                    )
                  }
                >
                  {authentication.state === "complete" && authenticationRequest?.method === "sso" ? (
                    <div className="grid min-w-0 justify-items-start gap-3">
                      <h4 className="m-0 text-label font-semibold">
                        Choose an account and permission set
                      </h4>
                      {!accounts.length ? (
                        <Button
                          variant="quiet"
                          disabled={pending}
                          onClick={() =>
                            void run("Loading AWS accounts…", async () => {
                              const next = await awsConnectionsApi.accounts(authentication.id);
                              setAccounts(next.accounts);
                              if (!next.accounts.length)
                                setMessage(
                                  "No AWS accounts are assigned to this session. Ask your administrator for an account assignment.",
                                );
                            })
                          }
                        >
                          Load assigned accounts
                        </Button>
                      ) : null}
                      {accounts.length ? (
                        <label className="grid w-full min-w-0 gap-1 text-label font-medium">
                          AWS account
                          <Select
                            controlSize="panel"
                            value={account}
                            disabled={pending}
                            onChange={(event) => chooseAccount(event.target.value)}
                          >
                            <option value="">Choose account…</option>
                            {accounts.map((item) => (
                              <option key={item.accountId} value={item.accountId}>
                                {item.accountName ? `${item.accountName} · ` : ""}
                                {item.accountId}
                              </option>
                            ))}
                          </Select>
                        </label>
                      ) : null}
                      {account ? (
                        <label className="grid w-full min-w-0 gap-1 text-label font-medium">
                          Permission set
                          <Select
                            controlSize="panel"
                            value={role}
                            disabled={pending}
                            onChange={(event) => setRole(event.target.value)}
                          >
                            <option value="">Choose permission set…</option>
                            {roles.map((item) => (
                              <option key={item.roleName}>{item.roleName}</option>
                            ))}
                          </Select>
                        </label>
                      ) : null}
                      <Button
                        variant="primary"
                        disabled={pending || !account || !role}
                        onClick={() =>
                          reviewFields(
                            authentication.profile,
                            {
                              ...(authenticationRequest.region
                                ? { region: authenticationRequest.region }
                                : {}),
                              sso_session: authenticationRequest.session!,
                              sso_account_id: account,
                              sso_role_name: role,
                            },
                            true,
                            authentication.id,
                          )
                        }
                      >
                        Review new profile
                      </Button>
                    </div>
                  ) : authentication.state === "complete" && authentication.reviewRequired ? (
                    <Button
                      variant="primary"
                      disabled={pending}
                      className="justify-self-start"
                      onClick={() =>
                        reviewFields(
                          authentication.profile,
                          authenticationRequest?.region
                            ? { region: authenticationRequest.region }
                            : {},
                          !authenticationRequest?.profile,
                          authentication.id,
                        )
                      }
                    >
                      Review signed-in profile
                    </Button>
                  ) : null}
                </AuthenticationProgress>
              ) : null}
              <div hidden={flowOpen} className="min-w-0">
                {adding ? (
                  <AddProfile
                    key={addingName ?? "new"}
                    catalog={catalog.data}
                    capabilities={capabilities}
                    fixedName={addingName}
                    busy={pending}
                    onAuthenticate={authenticate}
                    onReview={(name, fields) => reviewFields(name, fields, true)}
                  />
                ) : profile ? (
                  <AwsProfileDetails
                    profile={profile}
                    catalog={catalog.data}
                    observation={checks[profile.name] ?? observation.data}
                    associations={awsProfiles}
                    pending={pending}
                    onTest={() => void run("Checking connection…", () => check(profile.name))}
                    onAuthenticate={() => authenticate({ profile: profile.name })}
                    onLogout={() =>
                      void run("Preparing sign-out review…", async () =>
                        setLogoutReview(await awsConnectionsApi.logoutReview(profile.name)),
                      )
                    }
                    onUse={(modes) => associate(profile.name, modes)}
                    onSelectProfile={(name) => chooseProfile(name)}
                    onReview={(fields) => reviewFields(profile.name, fields, false)}
                  />
                ) : (
                  <div className="grid justify-items-start gap-3 px-5 py-4">
                    <h3 tabIndex={-1} className="m-0 text-label font-semibold">
                      Your AWS connections
                    </h3>
                    <p className={inspectorNoteClasses}>
                      Choose a profile to inspect it, or add one. Development and Production each
                      select a profile; deployments keep their own target and approval.
                    </p>
                    <Button
                      disabled={pending}
                      onClick={(event) => addProfile(event.currentTarget)}
                    >
                      Add AWS profile
                    </Button>
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : null}
      </div>
      <footer
        data-slot="aws-profile-feedback"
        aria-label="AWS profile status"
        tabIndex={error || busy || message ? 0 : undefined}
        className="h-8 flex-none overflow-y-auto border-t border-rule px-5 py-1 vp-420:px-4"
      >
        {error ? (
          <p role="alert" className="m-0 text-label text-refuse wrap-anywhere">
            {error}
          </p>
        ) : busy || message ? (
          <p
            role="status"
            className={cx("m-0 text-label wrap-anywhere", busy ? "text-graphite" : "text-accept")}
          >
            {busy || message}
          </p>
        ) : null}
      </footer>
    </dialog>,
    document.body,
  );
}
