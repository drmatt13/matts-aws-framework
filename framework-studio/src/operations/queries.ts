import { queryOptions } from "@tanstack/react-query";
import { operationsApi } from "./api";

export const operationsQuery = () => queryOptions({
  queryKey: ["operations"],
  queryFn: operationsApi.list,
});
