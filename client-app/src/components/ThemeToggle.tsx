import { useEffect, useState } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

type ThemeMode = "light" | "dark" | "auto";

const MODES: readonly { id: ThemeMode; label: string; Icon: LucideIcon }[] = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
  { id: "auto", label: "System", Icon: Monitor },
];

function getInitialMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "auto";
  }

  const stored = window.localStorage.getItem("theme");
  if (stored === "light" || stored === "dark" || stored === "auto") {
    return stored;
  }

  return "auto";
}

// Mirrors the pre-paint script in index.html. Keep the two in step: that one
// stops the flash of light theme on reload, this one handles every change after.
function applyThemeMode(mode: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = mode === "auto" ? (prefersDark ? "dark" : "light") : mode;

  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolved);

  if (mode === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }

  document.documentElement.style.colorScheme = resolved;
}

export default function ThemeToggle() {
  // Client-only app, so seeding straight from storage is safe -- and it keeps
  // the selected segment from flashing through "System" on first paint.
  const [mode, setMode] = useState<ThemeMode>(getInitialMode);

  useEffect(() => {
    applyThemeMode(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== "auto") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeMode("auto");

    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [mode]);

  function selectMode(next: ThemeMode) {
    setMode(next);
    window.localStorage.setItem("theme", next);
  }

  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-full border border-line bg-surface/70 p-0.5 shadow-xs backdrop-blur-md"
    >
      {MODES.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => selectMode(id)}
          aria-label={`${label} theme`}
          aria-pressed={mode === id}
          title={`${label} theme`}
          className={`grid size-7 cursor-pointer place-items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            mode === id
              ? "bg-ink text-canvas"
              : "text-muted hover:text-ink"
          }`}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
