import type {
  CreateUserInput,
  UpdateUserInput,
  UserRecord,
  UserRepository,
} from "./contracts.js";

export type CognitoUserIdentity = CreateUserInput;

export class CognitoIdentityConflictError extends Error {
  constructor(email: string) {
    super(`A user already exists for ${email} with a different Cognito identity.`);
    this.name = "CognitoIdentityConflictError";
  }
}

function profileUpdate(identity: CognitoUserIdentity): UpdateUserInput {
  return {
    email: identity.email,
    firstName: identity.firstName,
    lastName: identity.lastName,
  };
}

async function updateExistingIdentity(
  users: UserRepository,
  existing: UserRecord,
  identity: CognitoUserIdentity,
): Promise<UserRecord> {
  return (
    (await users.updateById(existing.id, profileUpdate(identity))) ??
    existing
  );
}

/**
 * Creates or refreshes the application profile for one verified Cognito
 * identity. Email is profile data, never authority to replace a Cognito sub.
 */
export async function ensureCognitoUser(
  users: UserRepository,
  identity: CognitoUserIdentity,
): Promise<UserRecord> {
  const existingBySub = await users.findByCognitoSub(identity.cognitoSub);
  if (existingBySub) {
    return updateExistingIdentity(users, existingBySub, identity);
  }

  const existingByEmail = await users.findByEmail(identity.email);
  if (existingByEmail) {
    throw new CognitoIdentityConflictError(identity.email);
  }

  try {
    return await users.create(identity);
  } catch (error) {
    // A post-confirmation trigger and OAuth callback can race on first login.
    // Re-read after a uniqueness failure so the operation remains idempotent.
    const concurrentlyCreated = await users.findByCognitoSub(
      identity.cognitoSub,
    );
    if (concurrentlyCreated) {
      return updateExistingIdentity(users, concurrentlyCreated, identity);
    }

    const conflictingEmail = await users.findByEmail(identity.email);
    if (conflictingEmail) {
      throw new CognitoIdentityConflictError(identity.email);
    }

    throw error;
  }
}
