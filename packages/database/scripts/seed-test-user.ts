import {
  CognitoIdentityConflictError,
  ensureCognitoUser,
} from "../src/cognito-users.js";
import type { UserRecord, UserRepository } from "../src/contracts.js";

/**
 * The local test user: one account in the dev Cognito pool and its row in the
 * local database, made from LOCAL_TEST_USER_EMAIL and LOCAL_TEST_USER_PASSWORD
 * in cdk-app/.env whenever Compose starts. A fresh dev deployment can then be
 * signed into, in the browser or with `npm run dev:request`, without a sign-up.
 *
 * An admin-created account never fires the post-confirmation trigger, so the
 * row is written here rather than by the replayed trigger.
 */

export type TestUserSettings = { email: string; password: string };

export type CognitoTestUser = {
  sub: string;
  givenName: string;
  familyName: string;
  emailVerified: boolean;
};

export type TestUserName = { givenName: string; familyName: string };

export interface TestUserDirectory {
  find(email: string): Promise<CognitoTestUser | undefined>;
  /** Creates a verified account without sending an invitation. */
  create(
    email: string,
    password: string,
    name: TestUserName,
  ): Promise<CognitoTestUser>;
  markEmailVerified(email: string): Promise<void>;
  /** Makes the password permanent, which also confirms the account. */
  setPermanentPassword(email: string, password: string): Promise<void>;
}

export const TEST_USER_NAME: TestUserName = {
  givenName: "Test",
  familyName: "User",
};

export type SettingsOutcome =
  | { status: "ready"; settings: TestUserSettings }
  | { status: "skipped"; reason: string };

export type SeedOutcome =
  | { status: "skipped"; reason: string }
  | { status: "ready"; createdInCognito: boolean; createdRow: boolean; user: UserRecord };

/**
 * Reads the test user from cdk-app/.env. A known password is acceptable in a
 * dev pool and never in a production one, so the pool must be a development
 * export's: `exportedDeployment` is LOCAL_FRAMEWORK_DEPLOYMENT from root .env,
 * which only `npm run export:cdk-outputs` of a development deployment writes.
 * A leftover PROD_DEPLOYMENT=true still refuses.
 */
export function testUserSettings(
  inputs: Readonly<Record<string, string | undefined>>,
  exportedDeployment: string | undefined,
): SettingsOutcome {
  if (!exportedDeployment?.trim()) {
    return {
      status: "skipped",
      reason:
        "root .env was not written by a development export (LOCAL_FRAMEWORK_DEPLOYMENT is unset); the test user is created only for a dev deployment. Run npm run export:cdk-outputs for your development deployment.",
    };
  }
  if (inputs.PROD_DEPLOYMENT?.trim().toLowerCase() === "true") {
    return {
      status: "skipped",
      reason:
        "cdk-app/.env says PROD_DEPLOYMENT=true; the test user is created only for a dev deployment.",
    };
  }

  const email = inputs.LOCAL_TEST_USER_EMAIL?.trim().toLowerCase();
  const password = inputs.LOCAL_TEST_USER_PASSWORD;
  if (!email || !password) {
    return {
      status: "skipped",
      reason:
        "Set LOCAL_TEST_USER_EMAIL and LOCAL_TEST_USER_PASSWORD in cdk-app/.env to create a local test user.",
    };
  }

  return { status: "ready", settings: { email, password } };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function seedTestUser(options: {
  settings: TestUserSettings;
  cognito: TestUserDirectory;
  users: UserRepository;
}): Promise<SeedOutcome> {
  const { settings, cognito, users } = options;
  const { email, password } = settings;

  let account: CognitoTestUser;
  let createdInCognito = false;
  try {
    const existing = await cognito.find(email);
    if (existing) {
      account = existing;
      if (!existing.emailVerified) {
        await cognito.markEmailVerified(email);
      }
    } else {
      // The password is checked against the pool's policy here, before the
      // account exists, so a rejected one leaves nothing half-created.
      account = await cognito.create(email, password, TEST_USER_NAME);
      createdInCognito = true;
    }
    // Every start, so the password in cdk-app/.env is always the one that works.
    await cognito.setPermanentPassword(email, password);
  } catch (error) {
    return { status: "skipped", reason: message(error) };
  }

  // An existing row is left alone: its name may have been edited in the app,
  // and Cognito's copy is not updated by that edit.
  const existingRow = await users.findByCognitoSub(account.sub);
  if (existingRow) {
    return { status: "ready", createdInCognito, createdRow: false, user: existingRow };
  }

  try {
    const user = await ensureCognitoUser(users, {
      cognitoSub: account.sub,
      email,
      firstName: account.givenName,
      lastName: account.familyName,
    });
    return { status: "ready", createdInCognito, createdRow: true, user };
  } catch (error) {
    if (error instanceof CognitoIdentityConflictError) {
      return {
        status: "skipped",
        reason: `${error.message} If prune-cognito-orphans skipped, fix what it reported and restart; otherwise remove that row or change LOCAL_TEST_USER_EMAIL.`,
      };
    }
    throw error;
  }
}
