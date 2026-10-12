import {
  CognitoIdentityProviderClient,
  paginateListUsers,
} from "@aws-sdk/client-cognito-identity-provider";
import { createClient } from "../src/client.js";
import { localDatabaseUrl, userPoolRegion } from "./local-users.js";
import { pruneCognitoOrphans } from "./prune-cognito-orphans.js";

// Compose runs this after migrations and before any database consumer starts.
// It reads USER_POOL_ID from the root .env that `npm run export:cdk-outputs`
// writes, and the AWS profile `npm run dev:containers -- --profile=` selected.

async function listCognitoSubs(userPoolId: string): Promise<Set<string>> {
  const client = new CognitoIdentityProviderClient({
    region: userPoolRegion(userPoolId) ?? process.env.AWS_REGION,
  });
  const subs = new Set<string>();

  try {
    for await (const page of paginateListUsers(
      { client, pageSize: 60 },
      { UserPoolId: userPoolId, AttributesToGet: ["sub"] },
    )) {
      for (const user of page.Users ?? []) {
        const sub = user.Attributes?.find(({ Name }) => Name === "sub")?.Value;
        // A user without a sub cannot vouch for any row, so the listing is
        // incomplete and nothing may be judged against it.
        if (!sub) {
          throw new Error(`Cognito returned user ${user.Username} without a sub.`);
        }
        subs.add(sub);
      }
    }
  } finally {
    client.destroy();
  }

  return subs;
}

async function main(): Promise<void> {
  const databaseUrl = localDatabaseUrl(process.env.DATABASE_URL);
  const userPoolId = process.env.USER_POOL_ID?.trim();
  if (!userPoolId) {
    console.warn(
      "USER_POOL_ID is not set; local users were not checked against Cognito. Run npm run export:cdk-outputs.",
    );
    return;
  }

  const { client, close } = createClient({ connectionString: databaseUrl });
  try {
    const users = client.orm.public.User;
    const outcome = await pruneCognitoOrphans({
      users: {
        list: async () =>
          (await users.all()).map(({ id, cognitoSub, email }) => ({
            id,
            cognitoSub,
            email,
          })),
        remove: async ({ id, cognitoSub }) =>
          (await users.where({ id, cognitoSub }).delete()) !== null,
      },
      listCognitoSubs: () => listCognitoSubs(userPoolId),
    });

    if (outcome.status === "skipped") {
      console.warn(
        `Could not list Cognito pool ${userPoolId}; local users were left unchanged. ${outcome.reason}`,
      );
      return;
    }

    for (const user of outcome.removed) {
      console.log(
        `Removed local user ${user.email} (sub ${user.cognitoSub}): not in Cognito pool ${userPoolId}.`,
      );
    }
    console.log(
      `Checked ${outcome.checked} local user(s) against Cognito pool ${userPoolId}; removed ${outcome.removed.length}.`,
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
