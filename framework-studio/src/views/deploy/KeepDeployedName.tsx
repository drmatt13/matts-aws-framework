import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AppNameReview, AppNameView } from "../../../shared/app-name";
import type { DeployMode } from "../../../shared/deploy";
import { call } from "../../http";
import {
  dialogBodyClasses,
  dialogClasses,
  dialogFooterClasses,
  dialogHeaderClasses,
  dialogPrimaryActionClasses,
  dialogTitleClasses,
} from "../../inspector-ui";
import { buttonClasses } from "../../ui/Button";
import { cx } from "../../ui/classes";
import { AppNameChange } from "../AppName";
import { DeploymentBadge } from "../DeploymentBadge";

/**
 * Keeps a stage deploying under the name AWS shows it deployed as, after the
 * app's name stopped deriving it: `deployAs` in cdk-app/cdk.json, reviewed
 * before it is written. Nothing is deployed.
 */
export function KeepDeployedName(props: {
  readonly stage: string;
  readonly mode: DeployMode;
  readonly deployAs: string;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const review = useQuery({
    queryKey: ["app-name", "deploy-as", props.stage, props.deployAs],
    queryFn: async () => {
      const view = await call<AppNameView>("/app-name");
      return call<AppNameReview>("/app-name/deploy-as/review", { stage: props.stage, deployAs: props.deployAs, hash: view.hash });
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const apply = async () => {
    if (!review.data) return;
    setBusy(true);
    setError(undefined);
    try {
      await call<{ name: string }>("/app-name/apply", { id: review.data.id });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["deploy"] }),
        queryClient.invalidateQueries({ queryKey: ["app-name"] }),
        queryClient.invalidateQueries({ queryKey: ["deployment-identities"] }),
      ]);
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      data-ui="keep-deployed-name"
      className={cx(dialogClasses(), "[&_code]:wrap-anywhere")}
      aria-labelledby="keep-deployed-name-title"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <header className={dialogHeaderClasses}>
        <h2
          id="keep-deployed-name-title"
          className={cx(dialogTitleClasses, "flex flex-wrap items-center gap-2 wrap-anywhere")}
        >
          Keep deploying to {props.deployAs} <DeploymentBadge kind={props.mode} />
        </h2>
      </header>
      <div className={cx(dialogBodyClasses, "grid gap-4")} aria-busy={review.isPending}>
        {review.isPending ? (
          <p className="m-0 text-graphite" role="status">
            Reviewing cdk-app/cdk.json…
          </p>
        ) : review.isError ? (
          <p className="m-0 text-refuse wrap-anywhere" role="alert">
            {review.error.message}
          </p>
        ) : (
          <AppNameChange review={review.data} />
        )}
        {error ? (
          <p className="m-0 text-refuse wrap-anywhere" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <footer className={dialogFooterClasses}>
        <button className={buttonClasses({ variant: "quiet", size: "regular" })} onClick={props.onClose}>
          Cancel
        </button>
        <button
          data-variant="primary"
          className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary", size: "regular" }))}
          disabled={!review.data || busy}
          onClick={() => void apply()}
        >
          Apply
        </button>
      </footer>
    </dialog>
  );
}
