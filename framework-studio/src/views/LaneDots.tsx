import type { Lanes } from "../../shared/model";

/** Three stops: local, development AWS, production AWS. Filled where it runs. */
export function LaneDots(props: { readonly lanes: Lanes }) {
  const { lanes } = props;
  const label = `Runs ${[lanes.local ? "locally" : null, lanes.dev ? "in development AWS" : null, lanes.prod ? "in production AWS" : null].filter(Boolean).join(", ") || "nowhere"}`;
  return (
    <span className="dots" role="img" aria-label={label} title={label}>
      <span className={`dot local ${lanes.local ? "on" : ""}`} />
      <span className={`dot dev ${lanes.dev ? "on" : ""}`} />
      <span className={`dot prod ${lanes.prod ? "on" : ""}`} />
    </span>
  );
}

export function LaneLegend() {
  return (
    <span className="legend">
      <span>
        <span className="dot local on" /> Local
      </span>
      <span>
        <span className="dot dev on" /> Development AWS
      </span>
      <span>
        <span className="dot prod on" /> Production AWS
      </span>
    </span>
  );
}
