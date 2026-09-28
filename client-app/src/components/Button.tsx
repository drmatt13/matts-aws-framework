// import React from 'react'

import { useEffect, useState } from "react";

interface ButtonProps {
  style?: "primary" | "secondary";
  text?: string;
  onClick?: () => void;
  disabled?: boolean;
  rainbow?: boolean;
  icon?:
    | "briefcase"
    | "continue"
    | "mail"
    | "plus"
    | "reset"
    | "save"
    | "sparkles"
    | "upload";
  submit?: boolean;
  fullWidth?: boolean;
  minWidth?: "sm" | "md" | "lg" | "xl";
  initiallyDisabled?: boolean;
}

import {
  ArrowRight,
  BriefcaseBusiness,
  ImageUp,
  Mail,
  PlusIcon,
  RotateCcw,
  Save,
  Sparkles,
} from "lucide-react";

const buttonIcons = {
  briefcase: BriefcaseBusiness,
  continue: ArrowRight,
  mail: Mail,
  plus: PlusIcon,
  reset: RotateCcw,
  save: Save,
  sparkles: Sparkles,
  upload: ImageUp,
} as const;

const minWidthClasses = {
  sm: "min-w-24",
  md: "min-w-28",
  lg: "min-w-36",
  xl: "min-w-44",
} as const;

const Button = ({
  style = "primary",
  text = "",
  onClick = () => {},
  disabled = false,
  rainbow = false,
  icon = undefined,
  submit = false,
  fullWidth = false,
  minWidth,
  initiallyDisabled = false,
}: ButtonProps) => {
  const [suppressHover, setSuppressHover] = useState(false);
  const [initialDisabled, setInitialDisabled] = useState(initiallyDisabled);
  const isDisabled = disabled || initialDisabled;
  const isRainbowPrimary = rainbow && style === "primary" && !isDisabled;
  const Icon = icon ? buttonIcons[icon] : null;

  useEffect(() => {
    if (initialDisabled) {
      setInitialDisabled(false);
    }
  }, [initialDisabled]);

  const baseClassName = `${fullWidth ? "w-full" : minWidth ? `${minWidthClasses[minWidth]} shrink-0` : "shrink-0"} ${icon ? "pl-3.5 pr-4" : "px-4"} relative isolate text-sm font-medium inline-flex items-center justify-center whitespace-nowrap py-2.5 rounded-lg border transition-colors ease-in duration-150 hover:ease-out hover:duration-100 overflow-visible focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/20`;
  // Tone and state resolve in one branch: Tailwind orders the stylesheet by
  // utility, not by the order classes appear here, so a disabled button can
  // only be certain of winning if it is the sole source of its own colours.
  const variantClassName = isDisabled
    ? "border-transparent bg-ink/10 text-ink/40 cursor-not-allowed"
    : style === "primary"
      ? "border-transparent bg-ink text-canvas shadow-sm cursor-pointer"
      : "border-line bg-ink/5 text-ink shadow-xs cursor-pointer";
  const stateClassName =
    isDisabled || suppressHover
      ? ""
      : style === "primary"
        ? "hover:bg-ink/85"
        : "hover:bg-ink/10";
  const rainbowClassName = isRainbowPrimary
    ? "bg-transparent before:pointer-events-none before:absolute before:bottom-[-.15rem] before:left-1/2 before:z-0 before:h-2 before:w-[94%] before:-translate-x-1/2 before:rounded-full before:bg-[linear-gradient(90deg,hsl(var(--color-rainbow-1)),hsl(var(--color-rainbow-5)),hsl(var(--color-rainbow-3)),hsl(var(--color-rainbow-4)),hsl(var(--color-rainbow-2)))] before:bg-[length:200%_100%] before:opacity-80 before:blur-sm before:content-[''] before:animate-rainbow after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:bg-[#1a1a1a] after:transition-colors after:content-[''] hover:after:bg-black"
    : "";
  const className = [
    baseClassName,
    variantClassName,
    stateClassName,
    rainbowClassName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      className={className}
      onClick={() => {
        setSuppressHover(true);
        onClick();
      }}
      onMouseLeave={() => setSuppressHover(false)}
      disabled={isDisabled}
      type={submit ? "submit" : "button"}
    >
      <span
        className={
          isRainbowPrimary
            ? "relative z-20 inline-flex items-center gap-2 whitespace-nowrap"
            : "relative z-0 inline-flex items-center gap-2 whitespace-nowrap"
        }
      >
        {Icon && <Icon className="h-4 w-4" />}
        {text}
      </span>
    </button>
  );
};

export default Button;
