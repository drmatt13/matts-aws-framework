import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Settings, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import {
  AWS_PROFILE_CONFIGURATION_EVENT,
  awsProfileIdentityQuery,
  awsProfilesQuery,
  checkAwsProfile,
  connectionStateLabels,
} from "../aws-profile-queries";
import { useQueryClient } from "@tanstack/react-query";
import { useStudio } from "../studio";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Select } from "../ui/FormControls";
import { AwsProfileConfiguration } from "./AwsProfileConfiguration";

function ProfileDetails({ onConfigure }: { readonly onConfigure: () => void }) {
  const { mode, awsProfile: profile, setAwsProfile, awsProfileCacheError } = useStudio();
  const label = mode === "dev" ? "Development" : "Production";
  const queryClient = useQueryClient();
  const profiles = useQuery(awsProfilesQuery());
  const available = profiles.data?.some((entry) => entry.name === profile);
  const identity = useQuery({
    ...awsProfileIdentityQuery(profile),
    enabled: Boolean(profile && available),
  });
  const observation = available ? identity.data : undefined;
  const context = observation?.identity;
  const staleIdentity = observation?.lastKnownIdentity;
  const problem = observation?.problem?.message ?? identity.error?.message;
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!profile) return;
    setRetrying(true);
    try {
      queryClient.setQueryData(
        awsProfileIdentityQuery(profile).queryKey,
        await checkAwsProfile(profile),
      );
    } finally {
      setRetrying(false);
    }
  };
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);
  const configure = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!profiles.isPending)
      (select.current?.disabled ? configure.current : select.current)?.focus();
  }, [profiles.isPending]);
  return (
    <div className="grid gap-4 p-4">
      <div className="grid gap-2 text-label">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={id} className="font-medium">
            AWS profile
          </label>
          <IconButton
            ref={configure}
            variant="quiet"
            size="compact"
            aria-label="Configure AWS profiles"
            title="Configure AWS profiles"
            onClick={onConfigure}
          >
            <Settings size={15} aria-hidden />
          </IconButton>
        </div>
        <Select
          ref={select}
          id={id}
          value={profile ?? ""}
          disabled={
            profiles.isPending || (!profile && (profiles.isError || !profiles.data?.length))
          }
          onChange={(event) => setAwsProfile(mode, event.target.value || undefined)}
        >
          <option value="">Choose a profile…</option>
          {profile && !available ? <option value={profile}>{profile} · unavailable</option> : null}
          {profiles.data?.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </Select>
      </div>
      {profiles.isPending ? (
        <p role="status" className="m-0 text-caption text-graphite">
          Loading AWS profiles…
        </p>
      ) : profiles.isError ? (
        <p role="alert" className="m-0 text-caption text-refuse">
          Could not load AWS profiles. {profiles.error.message}
        </p>
      ) : !profiles.data?.length ? (
        <p role="status" className="m-0 text-caption text-graphite">
          No AWS profiles on this machine.
        </p>
      ) : profile && !available ? (
        <p role="alert" className="m-0 text-caption text-refuse">
          The saved profile “{profile}” is unavailable on this machine. Choose another profile.
        </p>
      ) : profile && identity.isFetching && !context ? (
        <p role="status" className="m-0 text-caption text-graphite">
          Checking AWS account…
        </p>
      ) : context ? (
        <div className="grid gap-3 rounded-md border border-rule bg-wash p-3" role="status">
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-label">
            <dt>Account</dt>
            <dd className="m-0 font-mono font-medium">{context.account}</dd>
            <dt>Region</dt>
            <dd className="m-0 wrap-anywhere">{observation?.region.value ?? "Not configured"}</dd>
          </dl>
          <span className="flex min-w-0 items-center gap-2 text-caption" title={context.arn}>
            <Check size={14} className="shrink-0 text-accept" aria-hidden />
            <span className="wrap-anywhere">Signed in as {context.summary}</span>
          </span>
          <span className="text-caption text-graphite">
            {identity.isFetching ? "Checking identity…" : "Identity verified"}
            {observation?.checkedAt
              ? ` · ${new Date(observation.checkedAt).toLocaleTimeString()}`
              : ""}
          </span>
        </div>
      ) : problem ? (
        <div className="grid gap-2">
          <p role="alert" className="m-0 text-caption text-refuse">
            {observation
              ? connectionStateLabels[observation.state]
              : "Could not verify this profile"}
            . {problem}
          </p>
          {staleIdentity ? (
            <p className="m-0 text-caption text-graphite">
              Last verified: {staleIdentity.summary} · {staleIdentity.account} (stale)
            </p>
          ) : null}
        </div>
      ) : (
        <p role="status" className="m-0 text-caption text-graphite">
          {profile ? "Checking AWS account…" : `Choose an AWS profile for ${label}.`}
        </p>
      )}
      {profiles.isError || problem ? (
        <Button
          variant="quiet"
          size="compact"
          className="justify-self-start"
          disabled={profiles.isFetching || identity.isFetching || retrying}
          onClick={() => {
            if (profiles.isError) void profiles.refetch();
            else void retry().catch(() => {});
          }}
        >
          Try again
        </Button>
      ) : null}
      {observation?.state === "needs-auth" ? (
        <Button variant="primary" size="compact" onClick={onConfigure}>
          Reconnect
        </Button>
      ) : null}
      {awsProfileCacheError ? (
        <p role="alert" className="m-0 text-caption text-refuse">
          Browser storage is unavailable. Your selection is kept for this session.
        </p>
      ) : null}
    </div>
  );
}

/** Native nonmodal popover provides Escape, light dismissal and focus restoration. */
export function AwsProfileMenu({
  id,
  open,
  onOpenChange,
}: {
  readonly id: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { mode, awsProfile } = useStudio();
  const label = mode === "dev" ? "Development" : "Production";
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [top, setTop] = useState(0);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  useEffect(() => {
    const openConfiguration = () => {
      panel.current?.hidePopover?.();
      setConfigurationOpen(true);
    };
    window.addEventListener(AWS_PROFILE_CONFIGURATION_EVENT, openConfiguration);
    return () => window.removeEventListener(AWS_PROFILE_CONFIGURATION_EVENT, openConfiguration);
  }, []);
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => {
    panel.current?.hidePopover?.();
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const position = () => setTop((trigger.current?.getBoundingClientRect().bottom ?? 0) + 8);
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open]);
  return (
    <>
      <IconButton
        ref={trigger}
        variant="quiet"
        aria-label={`${label} AWS profile${awsProfile ? `: ${awsProfile}` : ": choose a profile"}`}
        title={`AWS profile for ${label}`}
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setTop((trigger.current?.getBoundingClientRect().bottom ?? 0) + 8)}
      >
        <ChevronDown size={15} className={open ? "rotate-180" : undefined} aria-hidden />
      </IconButton>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-labelledby={titleId}
        onToggle={(event) => onOpenChange(event.newState === "open")}
        style={{ top, maxHeight: `calc(100dvh - ${top + 12}px)` }}
        className="fixed right-4 bottom-auto left-auto z-30 m-0 w-[340px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-lg border border-rule-strong bg-sheet p-0 text-ink shadow-popover vp-560:right-3"
      >
        <header className="flex items-center justify-between gap-4 border-b border-rule px-4 py-3">
          <div className="grid gap-1">
            <span className="text-caption text-graphite">Declaration mode</span>
            <h2 id={titleId} className="m-0 text-body font-semibold">
              {label}
            </h2>
          </div>
          <IconButton
            variant="quiet"
            aria-label="Close AWS profile"
            onClick={() => panel.current?.hidePopover?.()}
          >
            <X size={15} aria-hidden />
          </IconButton>
        </header>
        {open ? (
          <ProfileDetails
            onConfigure={() => {
              panel.current?.hidePopover();
              setConfigurationOpen(true);
            }}
          />
        ) : null}
      </div>
      {configurationOpen ? (
        <AwsProfileConfiguration
          onClose={() => {
            setConfigurationOpen(false);
            trigger.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
