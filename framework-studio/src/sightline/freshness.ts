/** Disabled Query observers report isStale=false. Evaluate the owner's policy at capture. */
export function deploymentFreshness(input: { capturedAt: number; updatedAt: number; staleTime: number; invalidated: boolean; failed: boolean; available: boolean }) {
  const freshUntil = input.updatedAt ? input.updatedAt + input.staleTime : undefined;
  return {
    freshUntil: freshUntil === undefined ? undefined : new Date(freshUntil).toISOString(),
    stale: freshUntil === undefined || input.capturedAt >= freshUntil || input.invalidated || input.failed || !input.available,
  };
}
