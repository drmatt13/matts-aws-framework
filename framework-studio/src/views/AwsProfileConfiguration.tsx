import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { dialogClasses, dialogHeaderClasses, dialogTitleClasses } from "../inspector-ui";
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
import type { AwsConnectionObservation, AwsProfileCatalog } from "../../shared/aws-connections";
import { AddProfile } from "./AwsProfileForms";
import { AwsProfileDetails } from "./AwsProfileDetails";
import { AuthenticationProgress } from "./AwsProfileAuthentication";
import {
  ProfileChangeReview,
  ProfileDeletionReview as ProfileDeletionConfirmation,
  ProfileLogoutReview,
} from "./AwsProfileReviews";

const note = "m-0 text-caption text-graphite";
const sectionHeading = "m-0 text-body font-semibold";

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
        setAuthentication(next);
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
      setAccounts([]);
      setRoles([]);
      setAccount("");
      setRole("");
      setAuthentication(await awsConnectionsApi.authenticate(request));
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-5 py-4 vp-420:px-4">
        <p className={cx(note, "flex-none")}>
          Profiles live in your machine’s AWS configuration. Declaration modes choose a profile;
          deployments retain their own target and approval.
        </p>
        {catalog.isPending ? (
          <p role="status" className={note}>
            Loading AWS profiles…
          </p>
        ) : catalog.isError && !catalog.data ? (
          <div className="grid gap-2">
            <p role="alert" className="m-0 text-label text-refuse">
              Could not load AWS profiles. {catalog.error.message}
            </p>
            <Button variant="quiet" onClick={() => void catalog.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {catalog.data ? (
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[240px_minmax(0,1fr)] gap-5 vp-760:grid-cols-1">
            <aside
              aria-label="Configured AWS profiles"
              className={cx(
                "flex min-h-0 min-w-0 flex-col gap-3",
                detailVisible && "vp-760:hidden",
              )}
            >
              <div className="flex flex-none flex-wrap gap-2">
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
                <p className={note}>
                  No AWS profiles yet. Add a profile to connect your first account.
                </p>
              ) : null}
              <ul
                ref={profileList}
                className="m-0 grid min-h-0 list-none content-start gap-1 overflow-y-auto p-1 [scrollbar-gutter:stable]"
              >
                {defaultUnconfigured ? (
                  <li data-slot="aws-profile-card" data-profile="default">
                    <button
                      disabled={pending}
                      aria-label="Configure default AWS profile"
                      aria-current={adding && addingName === "default" ? "true" : undefined}
                      onClick={(event) => addProfile(event.currentTarget, "default")}
                      className={cx(
                        "group/profile grid h-[124px] w-full min-w-0 cursor-pointer grid-rows-[28px_18px_18px_18px] gap-1 rounded-md border border-rule bg-sheet p-3 text-left text-ink enabled:hover:bg-wash disabled:opacity-55",
                        adding && addingName === "default" && "border-rule-strong bg-wash",
                      )}
                    >
                      <strong className="self-center text-label">default</strong>
                      <span className="text-caption">Not configured</span>
                      <span className="text-caption">Click to configure</span>
                    </button>
                  </li>
                ) : null}
                {catalog.data.profiles.map((item) => {
                  const selected = !adding && item.name === selectedName;
                  const metadata = cx(
                    "m-0 truncate text-caption group-hover/profile:text-ink",
                    selected ? "text-ink" : "text-graphite",
                  );
                  const health =
                    checks[item.name] ??
                    queryClient.getQueryData<AwsConnectionObservation>(
                      awsProfileIdentityQuery(item.name).queryKey,
                    );
                  return (
                    <li
                      key={item.name}
                      className="relative"
                      data-slot="aws-profile-card"
                      data-profile={item.name}
                    >
                      <button
                        disabled={pending}
                        aria-current={selected ? "true" : undefined}
                        onClick={(event) => chooseProfile(item.name, event.currentTarget)}
                        className={cx(
                          "group/profile grid h-[124px] w-full min-w-0 cursor-pointer grid-rows-[28px_18px_18px_18px] gap-1 rounded-md border border-rule bg-sheet p-3 text-left text-ink enabled:hover:bg-wash disabled:opacity-55",
                          selected && "border-rule-strong bg-wash",
                        )}
                      >
                        <strong className="self-center truncate pr-8 text-label" title={item.name}>
                          {item.name}
                        </strong>
                        <span
                          className={metadata}
                          title={`${profileMethodLabels[item.kind]}${item.region ? ` · ${item.region}` : ""}`}
                        >
                          {profileMethodLabels[item.kind]}
                          {item.region ? ` · ${item.region}` : ""}
                        </span>
                        <span className={metadata}>
                          {health
                            ? connectionStateLabels[health.state]
                            : item.diagnostics.some((diagnostic) => diagnostic.severity === "error")
                              ? "Configuration issue"
                              : "Not checked"}
                        </span>
                        <span className={cx(metadata, "min-h-[18px]")}>
                          {[
                            awsProfiles.dev === item.name && "Development",
                            awsProfiles.prod === item.name && "Production",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </button>
                      <IconButton
                        variant="quiet"
                        size="compact"
                        tone="danger"
                        className="absolute top-2 right-2"
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
              {capabilities ? (
                <p className={cx(note, "flex-none")}>
                  {capabilities.available
                    ? `AWS CLI ${capabilities.version ?? "available"}`
                    : "AWS CLI unavailable"}
                </p>
              ) : null}
            </aside>
            <section
              ref={detailScroll}
              data-slot="aws-profile-detail-scroll"
              className={cx(
                "grid min-h-0 min-w-0 content-start gap-4 overflow-y-auto p-1 [scrollbar-gutter:stable]",
                !detailVisible && "vp-760:hidden",
              )}
              aria-label="AWS profile details"
            >
              <Button
                variant="link"
                size="compact"
                className="hidden justify-self-start vp-760:inline-flex"
                disabled={pending}
                onClick={showProfiles}
              >
                <ArrowLeft size={14} aria-hidden />
                All profiles
              </Button>
              {deletionReview ? (
                <ProfileDeletionConfirmation
                  review={deletionReview}
                  associations={awsProfiles}
                  pending={pending}
                  onCancel={cancelDeletion}
                  onConfirm={() =>
                    void run("Deleting profile…", async () => {
                      const result = await awsConnectionsApi.deleteProfile(deletionReview.id);
                      for (const mode of ["dev", "prod"] as const)
                        if (currentAssociations.current[mode] === result.name)
                          setAwsProfile(mode, undefined);
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
                      queryClient.removeQueries({
                        queryKey: awsProfileIdentityQuery(result.name).queryKey,
                      });
                      setMessage(result.name === "default"
                        ? "Default profile cleared."
                        : `Deleted profile ${result.name}.`);
                      try {
                        await refreshCatalog();
                      } catch {
                        setError(
                          "The profile was deleted, but the profile list could not refresh. Refresh the list to try again.",
                        );
                      }
                      window.requestAnimationFrame(() => {
                        if (addTrigger.current?.getClientRects().length) addTrigger.current.focus();
                        else
                          detailScroll.current?.querySelector<HTMLButtonElement>("button")?.focus();
                      });
                    })
                  }
                />
              ) : null}
              <div hidden={!!deletionReview} className="grid min-w-0 content-start gap-4">
                {authentication ? (
                  <AuthenticationProgress
                    session={authentication}
                    pending={!!busy}
                    onCancel={() =>
                      void run("Canceling sign-in…", async () =>
                        setAuthentication(await awsConnectionsApi.cancel(authentication.id)),
                      )
                    }
                    onConfirm={(accepted) =>
                      void run("Confirming identity…", async () =>
                        setAuthentication(
                          await awsConnectionsApi.confirm(authentication.id, accepted),
                        ),
                      )
                    }
                  />
                ) : null}
                {authentication?.state === "complete" && authenticationRequest?.method === "sso" ? (
                  <div className="grid gap-3">
                    <h3 className={sectionHeading}>Choose an account and permission set</h3>
                    {!accounts.length ? (
                      <Button
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
                      <label className="grid gap-1 text-label">
                        AWS account
                        <Select
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
                      <label className="grid gap-1 text-label">
                        Permission set
                        <Select
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
                      className="justify-self-start"
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
                ) : authentication?.state === "complete" && authentication.reviewRequired ? (
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
                {review ? (
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
                        setMessage(
                          result.message ||
                            "Profile saved.",
                        );
                        await refreshCatalog();
                        await check(result.name);
                        detailScroll.current?.scrollTo({ top: 0 });
                        window.requestAnimationFrame(() => {
                          detailScroll.current?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
                        });
                      })
                    }
                  />
                ) : null}
                {logoutReview ? (
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
                ) : null}
                {adding && !authentication ? (
                  <div hidden={!!review}>
                    <AddProfile
                      key={addingName ?? "new"}
                      catalog={catalog.data}
                      capabilities={capabilities}
                      fixedName={addingName}
                      busy={pending}
                      onAuthenticate={authenticate}
                      onReview={(name, fields) => reviewFields(name, fields, true)}
                    />
                  </div>
                ) : null}
                {!adding && profile ? (
                  <AwsProfileDetails
                    profile={profile}
                    catalog={catalog.data}
                    observation={checks[profile.name] ?? observation.data}
                    associations={awsProfiles}
                    pending={pending}
                    reviewOpen={!!review}
                    onTest={() => void run("Checking connection…", () => check(profile.name))}
                    onAuthenticate={() => authenticate({ profile: profile.name })}
                    onLogout={() =>
                      void run("Preparing sign-out…", async () =>
                        setLogoutReview(await awsConnectionsApi.logoutReview(profile.name)),
                      )
                    }
                    onUse={(mode) => {
                      setAwsProfile(mode, profile.name);
                      if (mode === activeMode)
                        void queryClient
                          .fetchQuery(awsProfileIdentityQuery(profile.name))
                          .catch(() => {});
                      setMessage(
                        `${profile.name} is selected for ${mode === "dev" ? "Development" : "Production"}.`,
                      );
                    }}
                    onReview={(fields) => reviewFields(profile.name, fields, false)}
                  />
                ) : null}
                {!adding && !profile ? (
                  <div className="grid gap-3">
                    <h3 className={sectionHeading}>Your AWS connections</h3>
                    <p className={note}>
                      Choose a profile to inspect its configuration, or add a connection. Profiles
                      can be shared by both declaration modes.
                    </p>
                    <Button
                      className="justify-self-start"
                      disabled={pending}
                      onClick={(event) => addProfile(event.currentTarget)}
                    >
                      Add AWS profile
                    </Button>
                  </div>
                ) : null}
                {catalog.data.environment.credentialsPresent ? (
                  <p className={note}>
                    AWS credential environment variables are present in the Studio process. They do
                    not replace a selected profile; an explicitly configured Environment source can
                    use them.
                  </p>
                ) : null}
                {catalog.data.environment.endpointOverridesPresent ? (
                  <p className={note}>
                    AWS endpoint overrides are present. Identity verification uses trusted AWS
                    endpoints.
                  </p>
                ) : null}
                {catalog.data.diagnostics.map((diagnostic, index) => (
                  <p key={index} className={note}>
                    {diagnostic.message}
                  </p>
                ))}
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
