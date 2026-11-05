import { lazy, Suspense, useEffect, useId, useRef } from "react";
import type { ThemeObject } from "@microlink/react-json-view";

const ReactJsonView = lazy(() => import("@microlink/react-json-view"));
// Studio tokens follow light/dark automatically, including third-party inline styles.
const theme: ThemeObject = {
  base00: "var(--sheet)", base01: "var(--wash)", base02: "var(--rule)", base03: "var(--graphite)",
  base04: "var(--graphite)", base05: "var(--ink)", base06: "var(--ink)", base07: "var(--ink)",
  base08: "var(--ink)", base09: "var(--ink)", base0A: "var(--ink)", base0B: "var(--ink)",
  base0C: "var(--graphite)", base0D: "var(--ink)", base0E: "var(--ink)", base0F: "var(--graphite)",
};

/** The installed viewer exposes click-only expanders. Adapt controls, never read data. */
export function JsonTree({ value, collapsed }: { value: object; collapsed: boolean | number }) {
  const container = useRef<HTMLDivElement>(null);
  const id = useId();
  const sequence = useRef(0);
  useEffect(() => {
    const root = container.current!;
    const adapt = () => {
      for (const icon of root.querySelectorAll<HTMLElement>(".icon-container")) {
        const expanded = Boolean(icon.querySelector(".expanded-icon"));
        icon.tabIndex = 0;
        icon.setAttribute("role", "button");
        icon.setAttribute("aria-expanded", String(expanded));
        icon.setAttribute("aria-label", expanded ? "Collapse JSON group" : "Expand JSON group");
        const key = icon.parentElement?.querySelector<HTMLElement>(".object-key");
        if (key) {
          key.id ||= `${id}-key-${++sequence.current}`;
          icon.setAttribute("aria-describedby", key.id);
        }
      }
    };
    adapt();
    const observer = new MutationObserver(adapt);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [id]);
  return <div ref={container} className="min-w-max p-3" onKeyDown={event => {
    const element = event.target;
    if (!(element instanceof HTMLElement) || !element.matches(".icon-container")) return;
    const expanded = element.getAttribute("aria-expanded") === "true";
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight" && !expanded || event.key === "ArrowLeft" && expanded) {
      event.preventDefault(); event.stopPropagation(); element.click();
    }
  }}>
    <Suspense fallback={<p role="status" className="m-0 text-caption text-graphite">Opening JSON viewer…</p>}>
      <ReactJsonView src={value} name="Sightline" collapsed={collapsed} indentWidth={2} theme={theme}
        enableClipboard={false} displayDataTypes={false} displayObjectSize={false} collapseStringsAfterLength={false}
        groupArraysAfterLength={1000} style={{ fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: "1.7" }} />
    </Suspense>
  </div>;
}
