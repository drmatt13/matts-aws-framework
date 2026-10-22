import { applicationVpc } from "../networks/application";
import type { EventsSection } from "../contracts";
import { resources } from "../resources";

/** Events declarations. Tags describe concerns independently of this module. */
export const events = {
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
    tags: { area: "auth" },
  },
  "cognito-custom-message": {
    environment: { FRONTEND_URL: resources.cognito.frontendUrl },
    tags: { area: "auth" },
  },
  "cognito-post-confirmation-trigger": {
    memorySize: 512,
    timeoutSeconds: 30,
    bundling: { sourceMap: false },
    localReplay: true,
    vpc: applicationVpc,
    database: true,
    tags: { area: "auth" },
  },

  /**
   * The validation step for the frontend's workflow.
   *
   * Declared here rather than under a handler section of its own: Step Functions
   * is one more native invoker of an ordinary event Lambda. `events` has no
   * `deploy` toggle by design — its invocation wiring is owned by whatever
   * constructs the trigger, which for this handler is the state machine.
   *
   * No `localReplay`: a capture-and-return path cannot substitute for the
   * synchronous result the next state reads.
   */

  "invocation-test-step": {
    timeoutSeconds: 10,
    tags: { area: "workflows" },
  },
} satisfies EventsSection;
