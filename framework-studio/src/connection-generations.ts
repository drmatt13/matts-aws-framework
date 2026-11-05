/** Coordination tokens only: AWS observations themselves live in the Query cache. */
export interface AwsConnectionGeneration {
  readonly all: number;
  readonly profiles: Readonly<Record<string, number>>;
}

interface ConnectionState {
  readonly awsConnectionGeneration?: AwsConnectionGeneration;
}

export function connectionGeneration(state: ConnectionState, profile: string | undefined): string {
  const generation = state.awsConnectionGeneration;
  const profileEpoch = profile ? generation?.profiles[profile] : undefined;
  return `${generation?.all ?? 0}:${typeof profileEpoch === "number" ? profileEpoch : 0}`;
}

/** The host reports an empty list when a change can affect every profile. */
export function advanceConnectionGeneration(
  current: AwsConnectionGeneration | undefined,
  profiles: readonly string[] = [],
): AwsConnectionGeneration {
  if (!profiles.length) return { all: (current?.all ?? 0) + 1, profiles: {} };
  let next = { ...current?.profiles };
  for (const profile of new Set(profiles)) next = {
    ...next,
    [profile]: (typeof next[profile] === "number" ? next[profile] : 0) + 1,
  };
  return { all: current?.all ?? 0, profiles: next };
}
