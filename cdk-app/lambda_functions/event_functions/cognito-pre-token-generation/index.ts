import type { PreTokenGenerationTriggerEvent } from "aws-lambda";

/**
 * A federated user of its own whose one identity is Facebook. A native account
 * someone linked a provider to keeps its own email_verified.
 */
function isFacebookUser(attributes: Readonly<Record<string, string>>): boolean {
  if (attributes["cognito:user_status"] !== "EXTERNAL_PROVIDER") return false;
  try {
    const identities: unknown = JSON.parse(attributes.identities ?? "[]");
    return (
      Array.isArray(identities) &&
      identities.length === 1 &&
      (identities[0] as { providerType?: unknown })?.providerType === "Facebook"
    );
  } catch {
    return false;
  }
}

/**
 * Marks a Facebook sign-in's email verified in its ID token, and changes nothing
 * else.
 *
 * Facebook Login returns only an address Meta has confirmed but sends no claim
 * that says so, and Cognito records an unmapped email_verified as "false", so
 * every verified-email gate would refuse a valid Meta identity. Only the token
 * changes: the user's attributes keep Cognito's answer, and the pre-signup
 * trigger never links a Facebook identity to an existing account by email.
 * Claim overrides are strings, so the claim is "true", which those gates accept.
 */
export const lambdaHandler = async (event: PreTokenGenerationTriggerEvent) => {
  const attributes = event.request.userAttributes;
  if (attributes.email && isFacebookUser(attributes)) {
    const details = event.response.claimsOverrideDetails ?? {};
    event.response.claimsOverrideDetails = {
      ...details,
      claimsToAddOrOverride: { ...details.claimsToAddOrOverride, email_verified: "true" },
    };
  }
  return event;
};
