import {
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
  ListIdentityProvidersCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { PreSignUpTriggerEvent } from "aws-lambda";

const cognito = new CognitoIdentityProviderClient({});

function shouldSkipEmailVerification(): boolean {
  return process.env.SKIP_EMAIL_VERIFICATION === "true";
}

function parseExternalProviderUserName(
  userName: string,
): { providerName: string; providerUserId: string } | null {
  const separatorIndex = userName.indexOf("_");

  if (separatorIndex <= 0 || separatorIndex === userName.length - 1) {
    return null;
  }

  return {
    providerName: userName.slice(0, separatorIndex),
    providerUserId: userName.slice(separatorIndex + 1),
  };
}

function hasAttribute(
  attributes: readonly { Name?: string; Value?: string }[] | undefined,
  name: string,
  expected: string,
): boolean {
  return (
    attributes?.some(
      (attribute) =>
        attribute.Name === name &&
        attribute.Value?.trim().toLowerCase() === expected,
    ) ?? false
  );
}

function escapeCognitoFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Cognito builds the external username as `<provider>_<subject>` and lowercases
 * the provider segment (`google_1234`), while AdminLinkProviderForUser requires
 * the provider's configured name (`Google`). The user pool is the authoritative
 * source for that spelling, so resolve it there rather than keeping a second
 * copy of provider configuration in this function. Adding an identity provider
 * stays a CDK-only change.
 */
async function resolveConfiguredProviderName(
  userPoolId: string,
  providerName: string,
): Promise<string | undefined> {
  const { Providers } = await cognito.send(
    new ListIdentityProvidersCommand({ UserPoolId: userPoolId }),
  );

  return Providers?.find(
    (provider) =>
      provider.ProviderName?.toLowerCase() === providerName.toLowerCase(),
  )?.ProviderName;
}

/**
 * Merges a federated identity into an existing native account matched by email.
 *
 * Declines rather than throws whenever anything is unproven: a throw here fails
 * the whole sign-up, so this function must never be able to block sign-in. The
 * safe direction is to let the identity federate as its own user.
 */
async function linkExternalProviderToExistingUser(
  event: PreSignUpTriggerEvent,
): Promise<void> {
  const email = event.request.userAttributes.email?.trim().toLowerCase();
  const externalProvider = parseExternalProviderUserName(event.userName);

  if (!email || !externalProvider) {
    return;
  }

  // With verification skipped, every native account's email_verified is an
  // assertion this pool made without sending a single message, so none of them
  // is proof of anything a link could rely on.
  if (shouldSkipEmailVerification()) {
    console.warn(
      `Skipping account linking for ${externalProvider.providerName}: email verification is skipped in this deployment.`,
    );
    return;
  }

  // Linking transfers ownership of an existing account to whoever controls the
  // federated identity. Only the provider's own verification makes that safe:
  // an unverified address would turn this into an account-takeover path. The
  // claim requires `emailVerified` in the provider's attribute mapping --
  // unmapped, Cognito reports "false" and no linking ever happens.
  if (event.request.userAttributes.email_verified !== "true") {
    console.warn(
      `Skipping account linking for ${externalProvider.providerName}: provider did not assert a verified email.`,
    );
    return;
  }

  const providerName = await resolveConfiguredProviderName(
    event.userPoolId,
    externalProvider.providerName,
  );

  if (!providerName) {
    console.warn(
      `Skipping account linking: ${externalProvider.providerName} is not a configured identity provider on this user pool.`,
    );
    return;
  }

  const users = await cognito.send(
    new ListUsersCommand({
      UserPoolId: event.userPoolId,
      Filter: `email = "${escapeCognitoFilterValue(email)}"`,
      Limit: 10,
    }),
  );

  // The destination has to have proven the address too. Matching on the email
  // attribute alone would hand this identity to whoever typed the address into
  // a sign-up form, or changed their own profile to it, without ever reading
  // mail sent there.
  const existingNativeUser = users.Users?.find(
    (user) =>
      user.Username &&
      user.UserStatus === "CONFIRMED" &&
      hasAttribute(user.Attributes, "email", email) &&
      hasAttribute(user.Attributes, "email_verified", "true"),
  );

  if (!existingNativeUser?.Username) {
    return;
  }

  await cognito.send(
    new AdminLinkProviderForUserCommand({
      UserPoolId: event.userPoolId,
      DestinationUser: {
        ProviderName: "Cognito",
        ProviderAttributeValue: existingNativeUser.Username,
      },
      SourceUser: {
        ProviderName: providerName,
        ProviderAttributeName: "Cognito_Subject",
        ProviderAttributeValue: externalProvider.providerUserId,
      },
    }),
  );
}

export const lambdaHandler = async (event: PreSignUpTriggerEvent) => {
  if (event.triggerSource === "PreSignUp_ExternalProvider") {
    await linkExternalProviderToExistingUser(event);
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
    return event;
  }

  if (shouldSkipEmailVerification()) {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  }

  return event;
};
