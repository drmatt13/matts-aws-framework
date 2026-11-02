import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, RefreshCw, X } from "lucide-react";
import {
  dialogBodyClasses,
  dialogClasses,
  dialogHeaderClasses,
  dialogTitleClasses,
} from "../inspector-ui";
import { cx } from "../ui/classes";
import { IconButton } from "../ui/IconButton";
import { Button } from "../ui/Button";
import { Select, TextInput } from "../ui/FormControls";
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
} from "../aws-connections-api";
import type { AwsCliCapabilities, AwsEditableFields } from "../../shared/aws-connection-management";
import type { AwsConnectionObservation, AwsProfileCatalog } from "../../shared/aws-connections";
import { AddProfile } from "./AwsProfileForms";
import { AwsProfileDetails } from "./AwsProfileDetails";
import { AuthenticationProgress } from "./AwsProfileAuthentication";
import { ProfileChangeReview, ProfileLogoutReview } from "./AwsProfileReviews";

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
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [detailVisible, setDetailVisible] = useState(Boolean(awsProfile));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [review, setReview] = useState<ProfileReview>();
  const [logoutReview, setLogoutReview] = useState<LogoutReview>();
  const [authentication, setAuthentication] = useState<AuthenticationSession>();
  const [authenticationRequest, setAuthenticationRequest] = useState<AuthenticationRequest>();
  const [accounts, setAccounts] = useState<readonly { accountId: string; accountName?: string }[]>(
    [],
  );
  const [roles, setRoles] = useState<readonly { roleName: string }[]>([]);
  const [account, setAccount] = useState("");
  const [role, setRole] = useState("");
  const [checks, setChecks] = useState<Record<string, AwsConnectionObservation>>({});
  const checksController = useRef<AbortController | undefined>(undefined);
  const loadedAccounts = useRef("");
  const currentAuthentication = useRef(authentication);
  currentAuthentication.current = authentication;
  const profile = catalog.data?.profiles.find((item) => item.name === selectedName);
  useEffect(() => {
    setChecks({});
    setReview(undefined);
    setLogoutReview(undefined);
  }, [live.awsConnectionRevision]);
  // The modal reads cached observations. Choosing a row never executes a credential provider.
  const observation = useQuery({ ...awsProfileIdentityQuery(profile?.name), enabled: false });
  const authActive = !!authentication && !authenticationFinished(authentication);
  const pending = !!busy || authActive;
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      checksController.current?.abort();
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
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["aws-connections"] });
    await catalog.refetch();
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
    if (busy && busy !== "Checking profiles…") return;
    dialog.current?.close();
    onClose();
  };
  const chooseProfile = (name: string) => {
    setSelectedName(name);
    setDetailVisible(true);
    setAdding(false);
    setReview(undefined);
    setLogoutReview(undefined);
    setError("");
    setMessage("");
    if (!authActive) setAuthentication(undefined);
  };
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className={dialogClasses({ size: "regular" })}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className={cx(dialogHeaderClasses, "flex items-center justify-between gap-4")}>
        <h2 id={titleId} className={dialogTitleClasses}>
          AWS profile configuration
        </h2>
        <IconButton
          autoFocus
          variant="quiet"
          disabled={!!busy && busy !== "Checking profiles…"}
          aria-label="Close AWS profile configuration"
          onClick={close}
        >
          <X size={16} aria-hidden />
        </IconButton>
      </header>
      <div className={cx(dialogBodyClasses, "gap-4")}>
        <p className={note}>
          Profiles live in your machine’s AWS configuration. Declaration modes choose a profile;
          deployments retain their own target and approval.
        </p>
        {error ? (
          <p
            role="alert"
            className="m-0 rounded-md border border-refuse p-3 text-label text-refuse wrap-anywhere"
          >
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="m-0 text-label text-accept wrap-anywhere">
            {message}
          </p>
        ) : null}
        {catalog.isPending ? (
          <p role="status" className={note}>
            Loading AWS profiles…
          </p>
        ) : catalog.isError ? (
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
          <div className="grid min-w-0 grid-cols-[240px_minmax(0,1fr)] gap-5 vp-760:grid-cols-1">
            <aside
              aria-label="Configured AWS profiles"
              className={cx("grid min-w-0 content-start gap-3", detailVisible && "vp-760:hidden")}
            >
              <label className="grid gap-1 text-caption">
                Find a profile
                <TextInput
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="compact"
                  disabled={pending}
                  onClick={() => {
                    setAdding(true);
                    setDetailVisible(true);
                    setAuthentication(undefined);
                    setReview(undefined);
                    setLogoutReview(undefined);
                  }}
                >
                  <Plus size={14} aria-hidden />
                  Add profile
                </Button>
                <IconButton
                  variant="quiet"
                  size="compact"
                  disabled={pending || catalog.isFetching}
                  aria-label="Refresh AWS profiles"
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={14} aria-hidden />
                </IconButton>
              </div>
              {!catalog.data.profiles.length ? (
                <p className={note}>
                  No AWS profiles yet. Add a profile to connect your first account.
                </p>
              ) : null}
              <ul className="m-0 grid list-none gap-1 p-0">
                {catalog.data.profiles
                  .filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
                  .map((item) => {
                    const health =
                      checks[item.name] ??
                      queryClient.getQueryData<AwsConnectionObservation>(
                        awsProfileIdentityQuery(item.name).queryKey,
                      );
                    return (
                      <li key={item.name}>
                        <button
                          disabled={pending}
                          aria-current={!adding && item.name === selectedName ? "true" : undefined}
                          onClick={() => chooseProfile(item.name)}
                          className={cx(
                            "grid w-full min-w-0 cursor-pointer gap-1 rounded-md border border-rule bg-sheet p-3 text-left text-ink enabled:hover:bg-wash disabled:opacity-55",
                            !adding && item.name === selectedName && "border-rule-strong bg-wash",
                          )}
                        >
                          <strong className="text-label wrap-anywhere">{item.name}</strong>
                          <span className={note}>
                            {profileMethodLabels[item.kind]}
                            {item.region ? ` · ${item.region}` : ""}
                          </span>
                          <span className={note}>
                            {health
                              ? connectionStateLabels[health.state]
                              : item.diagnostics.some(
                                    (diagnostic) => diagnostic.severity === "error",
                                  )
                                ? "Configuration issue"
                                : "Not checked"}
                          </span>
                          {awsProfiles.dev === item.name || awsProfiles.prod === item.name ? (
                            <span className="text-caption text-graphite">
                              {[
                                awsProfiles.dev === item.name && "Development",
                                awsProfiles.prod === item.name && "Production",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
              </ul>
              {catalog.data.profiles.length ? (
                <Button
                  variant="quiet"
                  size="compact"
                  disabled={pending}
                  onClick={() =>
                    void run("Checking profiles…", async () => {
                      const controller = new AbortController();
                      checksController.current = controller;
                      const queue = [...catalog.data!.profiles];
                      await Promise.all(
                        [0, 1].map(async () => {
                          while (queue.length && !controller.signal.aborted) {
                            const item = queue.shift()!;
                            await check(item.name, controller.signal);
                          }
                        }),
                      );
                    })
                  }
                >
                  Check profiles
                </Button>
              ) : null}
              {capabilities ? (
                <p className={note}>
                  {capabilities.available
                    ? `AWS CLI ${capabilities.version ?? "available"}`
                    : "AWS CLI unavailable"}
                </p>
              ) : null}
            </aside>
            <section
              className={cx("grid min-w-0 content-start gap-4", !detailVisible && "vp-760:hidden")}
              aria-label="AWS profile details"
            >
              <Button
                variant="link"
                size="compact"
                className="hidden justify-self-start vp-760:inline-flex"
                disabled={pending}
                onClick={() => setDetailVisible(false)}
              >
                <ArrowLeft size={14} aria-hidden />
                All profiles
              </Button>
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
                      authenticationRequest?.region ? { region: authenticationRequest.region } : {},
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
                          "Profile saved. Choose which declaration mode should use it.",
                      );
                      await refresh();
                      await check(result.name);
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
                      await refresh();
                    })
                  }
                />
              ) : null}
              {adding && !authentication ? (
                <div hidden={!!review}>
                  <AddProfile
                    catalog={catalog.data}
                    capabilities={capabilities}
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
                    Choose a profile to inspect its configuration, or add a connection. Profiles can
                    be shared by both declaration modes.
                  </p>
                  <Button
                    className="justify-self-start"
                    disabled={pending}
                    onClick={() => {
                      setAdding(true);
                      setDetailVisible(true);
                    }}
                  >
                    Add AWS profile
                  </Button>
                </div>
              ) : null}
              {busy ? (
                <p className={note} role="status">
                  {busy}
                </p>
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
            </section>
          </div>
        ) : null}
      </div>
    </dialog>,
    document.body,
  );
}
