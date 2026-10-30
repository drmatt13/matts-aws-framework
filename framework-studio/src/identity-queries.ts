import { queryOptions } from "@tanstack/react-query";
import type { Mode } from "../shared/model";
import { identityApi } from "./identity-api";

/** Source identity is independent of the explicit AWS inspection workflow. */
export const identitySourceQuery = (mode: Mode, revision: string) => queryOptions({
  queryKey: ["identity-source", mode, revision],
  queryFn: ({ signal }) => identityApi.source(mode, signal),
});
