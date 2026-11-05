import { useMemo, useState } from "react";
import { Button } from "../ui/Button";
import { buildSightline } from "./build";
import { useSightlineInputs } from "./useSightlineInputs";
import { JsonTree } from "./JsonTree";

export function SightlineView() {
  const inputs = useSightlineInputs();
  const value = useMemo(() => buildSightline(inputs), [inputs]);
  const json = useMemo(() => JSON.stringify(value), [value]);
  const [display, setDisplay] = useState({ key: 0, collapsed: 1 as boolean | number });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  return <section aria-label="Sightline" className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex flex-none flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
      <Button type="button" size="compact" onClick={() => {
        void navigator.clipboard.writeText(json).then(() => setCopyState("copied"), () => setCopyState("failed"));
      }}>Copy JSON</Button>
      <Button type="button" variant="quiet" size="compact" onClick={() => setDisplay(current => ({ key: current.key + 1, collapsed: false }))}>Expand all</Button>
      <Button type="button" variant="quiet" size="compact" onClick={() => setDisplay(current => ({ key: current.key + 1, collapsed: true }))}>Collapse all</Button>
      <span className="ml-auto text-caption text-graphite">{json.length.toLocaleString("en-US")} characters</span>
      {copyState !== "idle" ? <span role="status" className="text-caption text-graphite">{copyState === "copied" ? "JSON copied" : "Couldn’t copy JSON"}</span> : null}
    </div>
    <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain" tabIndex={0} aria-label="Sightline JSON">
      <JsonTree key={display.key} value={value} collapsed={display.collapsed} />
    </div>
  </section>;
}
