import type { EventsSection } from "../contracts";
import { resources } from "../resources";

export const cognitoEvents = {
  "cognito-pre-signup-trigger": {
    environment: {
      SKIP_EMAIL_VERIFICATION: resources.cognito.skipEmailVerification,
    },
    cloud: {
      constructId: "CognitoPreSignUpTrigger",
      access: [
        {
          actions: [
            "cognito-idp:AdminLinkProviderForUser",
            "cognito-idp:ListUsers",
            "cognito-idp:ListIdentityProviders",
          ],
          resources: [
            "arn:{partition}:cognito-idp:{region}:{account}:userpool/*",
          ],
        },
      ],
    },
  },
  "cognito-custom-message": {
    environment: { FRONTEND_URL: resources.cognito.frontendUrl },
  },
  "cognito-post-confirmation-trigger": {
    memorySize: 512,
    timeoutSeconds: 30,
    bundling: { sourceMap: false },
    localReplay: true,
    environment: {
      PRIMARY_DATABASE_SECRET_ARN: resources.rds.credentialsSecret.arn,
    },
  },
} satisfies EventsSection;
