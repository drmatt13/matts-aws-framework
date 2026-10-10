import type { PostConfirmationTriggerEvent } from "aws-lambda";
import { withLocalReplay } from "@repo/framework/runtime/event-replay";
import { databaseConnection } from "@repo/framework/runtime/database";
import { ensureCognitoUser, getDatabase } from "@repo/database";

/**
 * Creates the application's user row once Cognito confirms a sign-up.
 *
 * `withLocalReplay` is what `localReplay: true` in framework-config/events
 * asks for: in a dev deployment the invocation is captured and replayed
 * against the local database instead of running in AWS.
 */
export const lambdaHandler = withLocalReplay(
  async (event: PostConfirmationTriggerEvent) => {
    // Confirming a password reset fires this trigger too. The user row already
    // exists by then, so there is nothing to provision.
    if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") {
      return event;
    }

    const database = getDatabase(databaseConnection());
    const { sub, email, given_name, family_name } = event.request.userAttributes;

    await ensureCognitoUser(database.users, {
      cognitoSub: sub,
      email,
      firstName: given_name,
      lastName: family_name,
    });
    return event;
  },
);
