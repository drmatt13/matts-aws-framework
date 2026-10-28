import { defineResources, resource, type CloudMode } from "@repo/framework/config";

/**
 * The application's deployment settings: what decides which graph is built — its
 * name, domains, mail and retention — rather than what a workload reads.
 *
 * Declared with the catalog's own builders and resolved by its resolver, so each
 * reads the selected inputs file exactly as every workload input does: `-c`
 * context, then the file, then the default here. The shell is never read for
 * them. Studio lists them as owned rows in both inputs files.
 *
 * Declared for both graphs on purpose: cdk-app/deployment.ts refuses or ignores a
 * development setting in production out loud, which a setting the production
 * graph never read could not do.
 */
export const deploymentInputs = (mode: CloudMode) => defineResources({
  cdkAppName: resource.fromEnv("CDK_APP_NAME").default("matts-aws-framework")
    .note("Names a development deployment; a production deployment is its framework:targets name in cdk-app/cdk.json."),
  localDevUrl: resource.fromEnv("LOCAL_DEV_URL").default("http://localhost:3000")
    .note("Local frontend origin a development deployment trusts for sign-in callbacks and CORS."),
  skipEmailVerification: resource.fromEnv("SKIP_EMAIL_VERIFICATION").enum("true", "false").default("false")
    .note("Development only: confirm new users without a code. A production deployment refuses true."),
  cognitoSesFromEmail: resource.fromEnv("COGNITO_SES_FROM_EMAIL")
    .note("Verified SES sender for Cognito mail; without one, Cognito's own sender sends about 50 a day."),
  cognitoSesFromName: resource.fromEnv("COGNITO_SES_FROM_NAME").note("Sender display name; requires COGNITO_SES_FROM_EMAIL."),
  cognitoSesRegion: resource.fromEnv("COGNITO_SES_REGION").note("Region of the SES identity; requires COGNITO_SES_FROM_EMAIL."),
  retainStatefulResources: resource.fromEnv("RETAIN_STATEFUL_RESOURCES").enum("true", "false").default("false")
    .note("Fallback retention and deletion protection; a stateful resource's own policy takes precedence."),
  useFrontendCustomDomain: resource.fromEnv("USE_FRONTEND_CUSTOM_DOMAIN").enum("true", "false").default("true")
    .note("Production only: serve FRONTEND_URL; false keeps the generated CloudFront URL."),
  frontendUrl: resource.fromEnv("FRONTEND_URL").note("Production frontend URL; requires FRONTEND_CLOUDFRONT_CERTIFICATE_ARN."),
  frontendCloudFrontCertificateArn: resource.fromEnv("FRONTEND_CLOUDFRONT_CERTIFICATE_ARN")
    .note("ACM certificate in us-east-1, in the deployment account, for FRONTEND_URL."),
  prodUrl: resource.fromEnv("PROD_URL").note("Deprecated spelling of FRONTEND_URL."),
  prodCloudFrontCertificateArn: resource.fromEnv("PROD_CLOUDFRONT_CERTIFICATE_ARN").note("Deprecated spelling of FRONTEND_CLOUDFRONT_CERTIFICATE_ARN."),
  useCognitoCustomDomain: resource.fromEnv("USE_COGNITO_CUSTOM_DOMAIN").enum("true", "false").default("true")
    .note("Production only: serve the hosted UI from COGNITO_DOMAIN_NAME."),
  cognitoDomainName: resource.fromEnv("COGNITO_DOMAIN_NAME").note("Production hosted-UI domain; requires its certificate."),
  cognitoDomainCertificateArn: resource.fromEnv("COGNITO_DOMAIN_CERTIFICATE_ARN")
    .note("ACM certificate in us-east-1, in the deployment account, for COGNITO_DOMAIN_NAME."),
  googleClientId: resource.fromEnv("GOOGLE_CLIENT_ID").note("Google OAuth client ID; its secret is the GOOGLE_CLIENT_SECRET catalog secret."),
}, { mode });

export type DeploymentInputDeclarations = ReturnType<typeof deploymentInputs>;
