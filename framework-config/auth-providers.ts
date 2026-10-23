import type { AdditionalAuthProvider } from "../cdk-app/lib/app/auth-providers";

/** Application-owned federation declarations. Secret values belong only in CDK inputs. */
export const authenticationProviders: readonly AdditionalAuthProvider[] = [];
