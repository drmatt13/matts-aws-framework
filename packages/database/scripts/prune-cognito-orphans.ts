/**
 * Local users outlive their Cognito pool. The postgres_data volume persists
 * across `npm run dev:containers`, while destroying and redeploying the dev
 * stack creates a new pool with new subs. A row whose sub the current pool does
 * not hold can never sign in, and it still owns its email: signing up again
 * with that address fails with CognitoIdentityConflictError. Removing those
 * rows restores parity between the pool and the local database.
 *
 * Deletion is fail-closed. Nothing is removed unless the whole pool was listed
 * successfully, so missing credentials, an expired SSO session or a pool that
 * no longer exists leave every row in place.
 */

export type LocalUser = { id: string; cognitoSub: string; email: string };

export interface LocalUserStore {
  list(): Promise<LocalUser[]>;
  /** Removes one row by id and sub; false when it was already gone. */
  remove(user: LocalUser): Promise<boolean>;
}

export type PruneOutcome =
  | { status: "skipped"; reason: string }
  | { status: "checked"; checked: number; removed: LocalUser[] };

export async function pruneCognitoOrphans(options: {
  users: LocalUserStore;
  /** Every sub in the pool. Must throw rather than return a partial list. */
  listCognitoSubs: () => Promise<ReadonlySet<string>>;
}): Promise<PruneOutcome> {
  // Rows first: a row created after this read is never considered, so it
  // cannot be judged against a pool listing that predates it.
  const rows = await options.users.list();
  if (rows.length === 0) {
    return { status: "checked", checked: 0, removed: [] };
  }

  let subs: ReadonlySet<string>;
  try {
    subs = await options.listCognitoSubs();
  } catch (error) {
    return {
      status: "skipped",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const removed: LocalUser[] = [];
  for (const row of rows) {
    if (!subs.has(row.cognitoSub) && (await options.users.remove(row))) {
      removed.push(row);
    }
  }

  return { status: "checked", checked: rows.length, removed };
}
