import { FrameworkManagedStatus } from "./ResourceStatus";
import type { ModelRoute } from "../../shared/model";

/** Gateway routes are derived from their workload section, rather than authored resources. */
export function RouteStatus({
  route,
  placement,
}: {
  readonly route: ModelRoute;
  readonly placement?: "header" | "inline";
}) {
  return (
    <FrameworkManagedStatus
      placement={placement}
      title={`Routing generated from ${route.origin}`}
    />
  );
}
