import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import { createClient } from "../src/client.js";
import { createUserRepository } from "../src/users.js";
import { localDatabaseUrl, userPoolRegion } from "./local-users.js";
import {
  seedTestUser,
  testUserSettings,
  type CognitoTestUser,
  type TestUserDirectory,
} from "./seed-test-user.js";

// Compose runs this after prune-cognito-orphans and before any database
// consumer starts. cdk-app/.env.dev is bind-mounted read-only, as it is for every
// service that reads authored inputs; the password is never printed.

function readAuthoredInputs(): Record<string, string | undefined> {
  const file = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../cdk-app/.env.dev",
  );
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

function cognitoAccount(attributes: AttributeType[] | undefined): CognitoTestUser {
  const value = (name: string) =>
    attributes?.find(({ Name }) => Name === name)?.Value;
  const sub = value("sub");
  if (!sub) {
    throw new Error("Cognito returned the test user without a sub.");
  }
  return {
    sub,
    givenName: value("given_name") ?? "",
    familyName: value("family_name") ?? "",
    emailVerified: value("email_verified") === "true",
  };
}

function cognitoDirectory(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
): TestUserDirectory {
  // The pool signs in by email, so the email is the username every call takes.
  return {
    find: async (email) => {
      try {
        const user = await client.send(
          new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }),
        );
        return cognitoAccount(user.UserAttributes);
      } catch (error) {
        if (error instanceof UserNotFoundException) return undefined;
        throw error;
      }
    },
    create: async (email, password, { givenName, familyName }) => {
      const { User } = await client.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          TemporaryPassword: password,
          MessageAction: "SUPPRESS",
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "given_name", Value: givenName },
            { Name: "family_name", Value: familyName },
          ],
        }),
      );
      return cognitoAccount(User?.Attributes);
    },
    markEmailVerified: async (email) => {
      await client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [{ Name: "email_verified", Value: "true" }],
        }),
      );
    },
    setPermanentPassword: async (email, password) => {
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: email,
          Password: password,
          Permanent: true,
        }),
      );
    },
  };
}

async function main(): Promise<void> {
  // Compose passes LOCAL_FRAMEWORK_DEPLOYMENT from root .env: set only by a development export.
  const configured = testUserSettings(readAuthoredInputs(), process.env.LOCAL_FRAMEWORK_DEPLOYMENT);
  if (configured.status === "skipped") {
    console.log(`No local test user: ${configured.reason}`);
    return;
  }
  const { settings } = configured;

  const databaseUrl = localDatabaseUrl(process.env.DATABASE_URL);
  const userPoolId = process.env.USER_POOL_ID?.trim();
  if (!userPoolId) {
    console.warn(
      `USER_POOL_ID is not set; test user ${settings.email} was not created. Run npm run export:cdk-outputs.`,
    );
    return;
  }

  const cognito = new CognitoIdentityProviderClient({
    region: userPoolRegion(userPoolId) ?? process.env.AWS_REGION,
  });
  const { client, close } = createClient({ connectionString: databaseUrl });
  try {
    const outcome = await seedTestUser({
      settings,
      cognito: cognitoDirectory(cognito, userPoolId),
      users: createUserRepository(client),
    });

    if (outcome.status === "skipped") {
      console.warn(
        `Test user ${settings.email} is not ready in Cognito pool ${userPoolId}. ${outcome.reason}`,
      );
      return;
    }

    const made = [
      outcome.createdInCognito ? "created in Cognito" : "found in Cognito",
      outcome.createdRow ? "row created" : "row present",
    ].join(", ");
    console.log(
      `Test user ${settings.email} is ready in Cognito pool ${userPoolId} (${made}); its password is LOCAL_TEST_USER_PASSWORD.`,
    );
  } finally {
    cognito.destroy();
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
