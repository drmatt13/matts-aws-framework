// Type-only: declarations remain safe to load without constructing CDK.
import type { CognitoStack } from "../../cdk-app/lib/app/cognito-stack";
import type { RdsStack } from "../../cdk-app/lib/app/rds-stack";
import type { ReferenceExampleStack } from "../../cdk-app/lib/app/reference-example-stack";
import { resource } from "@repo/framework/config";
import { PROD_DEPLOYMENT } from "@repo/framework/config/source";

// One entry exposes every public construct and computed value on its stack.
// The stack constructor owns native resource creation and linkResources.
export const referenceExamples = resource.stack<ReferenceExampleStack>({
  tags: { area: "examples" },
});

// Also exposes the resolved frontend settings: userPoolDomainUrl,
// trustedOriginsCsv, frontendUrl and skipEmailVerification.
export const cognito = resource.stack<CognitoStack>({
  tags: { area: "auth" },
});

// Only production builds the database. The key still exists in the catalog
// during development, where Compose PostgreSQL stands in for it.
export const rds = PROD_DEPLOYMENT ? resource.stack<RdsStack>({
  tags: { area: "database" },
}) : undefined;
