import { defineResources, resource, type CloudMode } from "@repo/framework/config";

/**
 * The local development tooling's settings: what Docker Compose, the local Lambda runner and the
 * development scripts read from cdk-app/.env.dev, rather than what a deployment or a workload reads.
 * Declared with the catalog's own builders, with no defaults: the inputs file supplies each one.
 * Nothing is deployed from them and the production inputs file never supplies them. Host ports a
 * catalog input also reads (the API, WebSocket and tester ports) stay in the catalog.
 */
export const localInputs = () => defineResources({
  localAwsProfile: resource.fromEnv("LOCAL_AWS_PROFILE")
    .note("AWS profile for direct Docker Compose runs; blank uses the default profile. npm run dev:containers picks its own with --profile."),
  localAwsRegion: resource.fromEnv("LOCAL_AWS_REGION")
    .note("AWS region the local containers and invocation runner call."),
  localTestUserEmail: resource.fromEnv("LOCAL_TEST_USER_EMAIL")
    .note("Test account npm run dev:containers creates, verified, in the development pool and local database. Use an address you control."),
  localTestUserPassword: resource.fromEnv("LOCAL_TEST_USER_PASSWORD")
    .note("The test account's password, 12 or more characters. Never set in production."),
  localInvocationRunnerHostPort: resource.fromEnv("LOCAL_INVOCATION_RUNNER_HOST_PORT")
    .note("Host port Docker Compose publishes for the local invocation runner."),
  postgresHostPort: resource.fromEnv("POSTGRES_HOST_PORT").note("Host port Docker Compose publishes for local PostgreSQL."),
  pgadminHostPort: resource.fromEnv("PGADMIN_HOST_PORT").note("Host port Docker Compose publishes for pgAdmin."),
  localLambdaWarm: resource.fromEnv("LOCAL_LAMBDA_WARM").enum("true", "false")
    .note("Keeps warm Node processes in the local servers to cut cold starts; false starts every invocation cold."),
  localLambdaWarmMax: resource.fromEnv("LOCAL_LAMBDA_WARM_MAX").note("Warm processes kept at most."),
  localLambdaWarmIdleSeconds: resource.fromEnv("LOCAL_LAMBDA_WARM_IDLE_SECONDS").note("Idle seconds before a warm process exits."),
});

export type LocalInputDeclarations = ReturnType<typeof localInputs>;

/**
 * What each CDK inputs file must write for the framework itself: the uncommented framework lines of
 * cdk-app/.env.<mode>.template, which a generated file therefore holds. AWS Studio shows every
 * framework setting as a framework-managed input with no default, and a required one its file leaves
 * unset as a missing value on its supply connection, so an edited template or file cannot quietly
 * drop one. LOCAL_AWS_PROFILE is written by the template but may stay blank. Synthesis keeps the
 * fallbacks its own declarations give. framework-studio/test/framework-settings.test.ts keeps both
 * templates in step with this list.
 */
export const REQUIRED_FRAMEWORK_INPUTS: Readonly<Record<CloudMode, readonly string[]>> = {
  dev: [
    "CDK_APP_NAME", "USE_COGNITO_CUSTOM_DOMAIN", "SKIP_EMAIL_VERIFICATION", "LOCAL_DEV_URL",
    "LOCAL_AWS_REGION", "LOCAL_TEST_USER_EMAIL", "LOCAL_TEST_USER_PASSWORD",
    "LOCAL_INVOCATION_RUNNER_HOST_PORT", "POSTGRES_HOST_PORT", "PGADMIN_HOST_PORT",
    "LOCAL_LAMBDA_WARM", "LOCAL_LAMBDA_WARM_MAX", "LOCAL_LAMBDA_WARM_IDLE_SECONDS",
  ],
  prod: [
    "USE_FRONTEND_CUSTOM_DOMAIN", "USE_COGNITO_CUSTOM_DOMAIN",
    "DATABASE_INSTANCE_CLASS", "DATABASE_ENGINE_VERSION", "DATABASE_ALLOW_MAJOR_VERSION_UPGRADE", "DATABASE_MULTI_AZ",
    "DATABASE_STORAGE_TYPE", "DATABASE_ALLOCATED_STORAGE_GIB", "DATABASE_MAX_ALLOCATED_STORAGE_GIB",
    "DATABASE_BACKUP_RETENTION_DAYS", "DATABASE_AUTO_MINOR_VERSION_UPGRADE", "DATABASE_READ_REPLICA_COUNT",
    "DATABASE_READ_REPLICA_MULTI_AZ", "DATABASE_PROXY_ENABLED", "DATABASE_PROXY_MAX_CONNECTIONS_PERCENT",
    "DATABASE_PROXY_BORROW_TIMEOUT_SECONDS", "DATABASE_PROXY_IDLE_CLIENT_TIMEOUT_SECONDS", "DATABASE_LOG_RETENTION_DAYS",
  ],
};
