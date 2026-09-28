import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCurrentUser,
  updateUser,
  type CurrentUser,
  type UpdateUserPayload,
} from "./operations";
import { isSessionExpiredError } from "#/lib/auth";

export const currentUserQueryKey = ["currentUser"] as const;

export function useCurrentUserQuery(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: currentUserQueryKey,
    queryFn: getCurrentUser,
    enabled: options.enabled ?? true,
    retry: (failureCount, error) =>
      !isSessionExpiredError(error) && failureCount < 2,
  });
}

export function useUpdateUserMutation() {
  const queryClient = useQueryClient();

  return useMutation<CurrentUser, Error, UpdateUserPayload>({
    mutationFn: updateUser,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    },
  });
}

export type { CurrentUser, UpdateUserPayload };
