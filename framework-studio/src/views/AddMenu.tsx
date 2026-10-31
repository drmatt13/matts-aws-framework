import { cx } from "../ui/classes";
import { buttonClasses } from "../ui/Button";
import {
  Bot,
  Container,
  KeyRound,
  Layers3,
  Network,
  Plus,
  Route,
  SquareFunction,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { CREATORS, type CreationKind } from "../../shared/creation";
import { useStudio } from "../studio";
import { CreationWizard } from "./CreationWizard";

const options = [
  { kind: "function", icon: SquareFunction },
  { kind: "stack", icon: Layers3 },
  { kind: "vpc", icon: Network },
  { kind: "workflow", icon: Workflow },
  { kind: "service", icon: Container },
  { kind: "task", icon: Container },
  { kind: "route", icon: Route },
  { kind: "agent", icon: Bot },
  { kind: "tool", icon: SquareFunction },
  { kind: "input", icon: Plus, label: "Input parameter or secret" },
  { kind: "auth-provider", icon: KeyRound },
] satisfies { kind: CreationKind; icon: typeof Plus; label?: string }[];

/** Creation shares the Inspector's guarded draft and complete diff review. */
export function AddMenu({
  presentation = "floating",
}: {
  readonly presentation?: "floating" | "toolbar";
}) {
  const { draft, draftState, live } = useStudio();
  const creation = draft.creation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const id = useId();
  const unavailable = Object.values(draftState.baseline.models).some(
    (model) => model.stale || model.status === "error",
  );
  const disabled = unavailable || !!draftState.busy || live.evaluating;
  const focusClasses = cx(
    "focus-visible:outline-2 focus-visible:outline-offset-[3px]",
    presentation === "toolbar" ? "focus-visible:outline-prod" : "focus-visible:outline-map-focus",
  );

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <>
      <div
        data-ui="landscape-add"
        data-presentation={presentation}
        className="pointer-events-auto relative z-5 shrink-0"
        ref={root}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        {open ? (
          <div
            data-ui="landscape-add-menu"
            className={cx(
              "absolute right-0 bottom-[52px] max-h-[calc(100dvh-180px)] w-[min(320px,calc(100vw-48px))] overflow-y-auto overscroll-contain rounded-lg border p-4 shadow-popover vp-900:fixed vp-900:right-(--workspace-gutter) vp-900:bottom-4 vp-900:z-30 vp-900:max-h-[calc(100dvh-32px)] vp-900:w-[min(360px,calc(100vw-32px))]",
              presentation === "toolbar"
                ? "top-[calc(100%+12px)] bottom-auto border-rule-strong bg-sheet text-ink vp-900:top-auto vp-900:bottom-4"
                : "border-map-rule bg-map-panel text-map-ink",
            )}
            id={id}
            role="dialog"
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-description`}
          >
            <div
              data-ui="landscape-add-heading"
              className="flex items-center justify-between gap-3"
            >
              <h2 className="m-0 font-sans text-[16px] font-semibold" id={`${id}-title`}>
                Add to application
              </h2>
              <button
                ref={close}
                data-ui="landscape-add-close"
                className={cx(
                  focusClasses,
                  "flex size-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0",
                  presentation === "toolbar"
                    ? "text-graphite hover:bg-wash hover:text-ink"
                    : "text-[#b9c7d8] hover:bg-[#ffffff12]",
                )}
                aria-label="Close add menu"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <p
              id={`${id}-description`}
              className={cx(
                "mt-2 mb-4 text-caption leading-[1.5]",
                presentation === "toolbar" ? "text-graphite" : "text-[#a3b1c4]",
              )}
            >
              Choose what to add, configure it, then review the source changes.
            </p>
            {disabled ? (
              <p className="text-refuse wrap-anywhere" role="status">
                {unavailable
                  ? "Fix the configuration errors in Configuration health before adding resources."
                  : "Wait for the current validation to finish before adding a resource."}
              </p>
            ) : null}
            <div
              data-ui="landscape-add-options"
              className="grid grid-cols-2 gap-2"
              onKeyDown={(event) => {
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
                const current = items.indexOf(event.target as HTMLButtonElement);
                if (current < 0) return;
                const moves: Record<string, number> = {
                  ArrowRight: 1,
                  ArrowLeft: -1,
                  ArrowDown: 2,
                  ArrowUp: -2,
                };
                const movement = moves[event.key];
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : movement === undefined
                        ? undefined
                        : (current + movement + items.length) % items.length;
                if (next === undefined) return;
                event.preventDefault();
                items[next]?.focus();
              }}
            >
              {options.map(({ kind, icon: Icon, ...option }) => (
                <button
                  className={cx(
                    focusClasses,
                    "flex min-h-12 min-w-0 cursor-pointer flex-row items-center gap-2 rounded-md border p-3 text-left text-caption disabled:cursor-not-allowed disabled:opacity-50",
                    presentation === "toolbar"
                      ? "border-rule bg-paper text-ink enabled:hover:border-graphite enabled:hover:bg-wash"
                      : "border-[#2c394b] bg-[#1a2534] text-[#b9c7d8] enabled:hover:border-[#7791b0] enabled:hover:bg-map-row enabled:hover:text-[#eef4fc]",
                  )}
                  key={kind}
                  disabled={disabled}
                  title={CREATORS[kind].help}
                  onClick={() => {
                    const start = () => {
                      draft.beginCreation(kind);
                      setOpen(false);
                    };
                    if (
                      creation?.resourceKind === kind ||
                      (kind === "input" && creation?.resourceKind === "secret")
                    )
                      setOpen(false);
                    else draft.requestNavigation(start);
                  }}
                >
                  <Icon size={18} aria-hidden />
                  <span className="min-w-0 wrap-anywhere">
                    {"label" in option ? option.label : CREATORS[kind].label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <button
          ref={trigger}
          className={cx(
            focusClasses,
            presentation === "toolbar"
              ? buttonClasses({ variant: "quiet" })
              : "flex size-10 cursor-pointer items-center justify-center rounded-full border border-[#ffffff24] bg-transparent bg-[linear-gradient(145deg,#29313ecc,#151c28e6)] p-0 text-[#cbd5e1] shadow-[0_3px_12px_#0004,inset_0_1px_0_#ffffff0a] backdrop-blur-[12px] transition-[border-color,color] duration-150 hover:border-[#ffffff45] hover:bg-[linear-gradient(145deg,#343f50e6,#202b3be6)] hover:text-[#f1f5f9] aria-expanded:border-[#ffffff45] aria-expanded:bg-[linear-gradient(145deg,#343f50e6,#202b3be6)] aria-expanded:text-[#f1f5f9]",
          )}
          aria-label="Add to application"
          title="Add to application"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => {
            const show = () => setOpen((value) => !value);
            if (creation) show();
            else draft.requestNavigation(show);
          }}
        >
          <Plus size={presentation === "toolbar" ? 16 : 20} strokeWidth={1.75} aria-hidden />
          {presentation === "toolbar" ? <span>Add to application</span> : null}
        </button>
      </div>
      {creation && !open ? <CreationWizard entry={creation} back={() => setOpen(true)} /> : null}
    </>
  );
}
