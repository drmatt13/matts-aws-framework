import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig,
  defineResources,
  getFrameworkTargets,
  assertRequirementsMet,
  getSecretBindings,
  resolveCloudValues,
  resource,
  validateFrameworkConfig,
  type CloudRequirement,
  type FrameworkConfig,
  type NormalizedTarget,
  type RequirementLane,
  type ResolvedCloudRequirement,
  type ResourceResolver,
  type SecretHandle,
} from "@repo/framework/config";
import { defaults } from "../../../framework-config/defaults";

/**
 * Secrets, declared once in the catalog and delivered where they are read.
 *
 * Two questions, deliberately answered in two places. The catalog says which
 * secret — `resource.secret("NAME")` for one you author in cdk-app/.env, a
 * public field for one a stack built or imported. The workload says what it
 * wants from it: `.value` or `.field()` under `secrets` to be handed the
 * contents at startup, or `.arn` in `environment` to read it for itself.
 *
 * All four combinations work, which is the point of splitting them. What is
 * checked here is that neither question leaks into the other, that a secret's
 * *value* still has no route into a CloudFormation template, and that the
 * refusals name the line to change.
 */

/**
 * A stack, structurally. `resource.stack<T>()` reads a type, not a class, so a
 * test names the shape it needs rather than building a CDK app to get one.
 */
interface DatabaseStack {
  readonly credentials: { readonly secretArn: string; grantRead(...args: never[]): unknown };
}

const resources = defineResources({
  database: resource.stack<DatabaseStack>(),
  openaiApiKey: resource.secret(),
  langgraph: {
    modelProvider: resource.fromEnv().enum("bedrock", "openai").default("bedrock"),
  },
});

/** The same catalog, as a deployment that builds no database declares it. */
const withoutDatabase = defineResources({
  database: (false as boolean) ? resource.stack<DatabaseStack>() : undefined,
});

const DIRECTORY = "/ecs_containers/services/langgraph";
const LAMBDA_DIRECTORY = "/lambda_functions/http_functions/graphql-api";

function serviceConfig(
  secrets: Record<string, unknown>,
  requirements: readonly CloudRequirement[] = [],
): FrameworkConfig {
  return defineFrameworkConfig({
    resources,
    defaults,
    http: [],
    webSocket: [],
    services: [
      {
        "/example/*": {
          directory: DIRECTORY,
          methods: "*",
          auth: true,
          port: 5000,
          deploy: "both",
          secrets,
          cloud: { constructId: "ExampleService", requirements },
        },
      },
    ],
    events: [],
    tasks: [],
    workflows: [],
  } as never);
}

function lambdaConfig(environment: Record<string, unknown>): FrameworkConfig {
  return defineFrameworkConfig({
    resources,
    defaults,
    http: [
      {
        "/graphql": {
          directory: LAMBDA_DIRECTORY,
          methods: ["POST"],
          auth: true,
          environment,
          cloud: { constructId: "GraphQLApi" },
        },
      },
    ],
    webSocket: [],
    services: [],
    events: [],
    tasks: [],
    workflows: [],
  } as never);
}

function target(config: FrameworkConfig, kind: "service" | "lambda"): NormalizedTarget {
  const found = getFrameworkTargets(config).find((entry) => entry.kind === kind);
  assert.ok(found, `the fixture declares one ${kind}`);
  return found;
}

const SYNCED_ARN =
  "arn:aws:secretsmanager:eu-west-2:111122223333:secret:x-AbCdEf";
const SYNCED_NAME = "matts-aws-framework/secret/OPENAI_API_KEY";

/**
 * A lane, as the resolver `resolveCloudValues` actually takes.
 *
 * Production closes over the CDK registry or the local process environment;
 * a fixture closes over a map keyed by catalog path. Same contract, no
 * deployment. A secret answers with its handle, or with the bare ARN when the
 * reference is the `.arn` projection — which is what both lanes do.
 */
function supplying(values: Readonly<Record<string, string | SecretHandle>>): ResourceResolver {
  return (reference) => {
    const supplied = values[reference.path.join(".")];
    if (supplied === undefined) return undefined;
    if (typeof supplied === "string") return supplied;
    return reference.secretArn ? supplied.secretArn : supplied;
  };
}

/** Nothing supplied: the lane a graph that holds none of this would present. */
const nothing: ResourceResolver = () => undefined;

/** The same map, as the lane `assertRequirementsMet` asks its two questions of. */
function lane(values: Readonly<Record<string, string | SecretHandle>>): RequirementLane {
  return {
    select: (reference) => values[reference.path.join(".")] as string | undefined,
    supplied: (reference) => values[reference.path.join(".")] !== undefined,
  };
}

/** What the requirement evaluator is handed for one of this file's targets. */
function requirements(config: FrameworkConfig, kind: "service" | "lambda") {
  return target(config, kind).cloud.requirements as readonly ResolvedCloudRequirement[];
}

const WHEN_OPENAI: CloudRequirement = {
  when: { resource: resources.langgraph.modelProvider, equals: "openai" },
  require: [resources.openaiApiKey],
  message: "The task reads the key at startup.",
};

// ---------------------------------------------------------------------------
// Declaring
// ---------------------------------------------------------------------------

test("a secret is one catalog entry, whoever supplies its value", () => {
  assert.equal(resources.openaiApiKey.kind, "secret");
  assert.equal(resources.openaiApiKey.fromEnv, "OPENAI_API_KEY");
  // A stack's secret is read through a projection, and the projection is what
  // carries the kind: the field name alone does not say whether the workload
  // wants the address or the contents.
  assert.equal(resources.database.credentials.value.kind, "secret");
  assert.equal(resources.database.credentials.value.fromEnv, undefined);
  assert.equal(resources.database.credentials.arn.kind, "string");
  assert.equal(resources.database.credentials.arn.secretArn, true);
  assert.deepEqual(resources.database.credentials.arn.path, ["database", "credentials"]);
});

test("an entry the catalog declares undefined keeps its shape and resolves to nothing", () => {
  // The whole of what replaced a per-resource mode. The config branched, every
  // reader still compiles, and nothing has to know what a deployment mode is.
  assert.equal(withoutDatabase.database.credentials.arn.absent, true);
  assert.equal(resources.database.credentials.arn.absent, undefined);
});

test("a declaration finalizes to plain data, with no chain left on it", () => {
  // The promise the module opens with. stableStringify compares declarations,
  // and a method surviving into the catalog would be a declaration that does
  // not serialize as the data it is.
  assert.equal(Object.getPrototypeOf(resources.openaiApiKey), Object.prototype);
  for (const value of Object.values(resources.openaiApiKey)) {
    assert.notEqual(typeof value, "function");
  }
});

test("something that is not a declaration is named for what to write instead", () => {
  assert.throws(
    // @ts-expect-error a plain string is not a declaration
    () => defineResources({ orphan: "LANGGRAPH_BEDROCK_MODEL_ID" }),
    /is not a resource declaration.*resource\.fromEnv\("NAME"\).*resource\.stack<T>\(\)/s,
  );
});

test("a declared variable name has to be one a shell could export", () => {
  assert.throws(() => resource.fromEnv("not-screaming"), /SCREAMING_SNAKE_CASE/);
  assert.throws(() => resource.secret("not-screaming"), /SCREAMING_SNAKE_CASE/);
});

function illegalCombinations(): void {
  // Each of these used to be a runtime refusal, and each is a type error now:
  // that is the whole reason the chain narrows as it goes. `npm run typecheck`
  // is the assertion — every @ts-expect-error below fails the build if the
  // combination it marks ever becomes writable again.
  //
  // Never executed: some of these are gone at runtime too, and the assertion
  // is `npm run typecheck`, not this body.
  // @ts-expect-error a secret has no default: a fallback would be a secret in a source file
  resource.secret().default("x");
  // @ts-expect-error an env-backed declaration infers its own optionality
  resource.fromEnv().optional();
  // @ts-expect-error a choice list restricts a variable, and a secret is not one
  resource.secret().enum("a", "b");
  // @ts-expect-error a value the deployment computes is a stack field, not an origin
  resource.fromEnv().fromCdk();
  // @ts-expect-error a stack's secret is read through a projection, never bare
  const bare: ResourceReference<"secret"> = resources.database.credentials;
  void bare;
}
void illegalCombinations;

test("the entry points are the only four, and none of them is an origin chain", () => {
  // The runtime object agrees with the types above, so a config written in
  // plain JavaScript meets the same surface.
  assert.deepEqual(Object.keys(resource).sort(), ["cdk", "fromEnv", "secret", "stack"]);
  assert.equal((resource.fromEnv() as unknown as Record<string, unknown>).fromCdk, undefined);
  assert.equal((resource.secret() as unknown as Record<string, unknown>).fromCdk, undefined);
});

// ---------------------------------------------------------------------------
// Delivering the value: a container's startup secret
// ---------------------------------------------------------------------------

test("a container names the catalog entry, under whatever variable it reads", () => {
  const config = serviceConfig({ OPENAI_API_KEY: resources.openaiApiKey });
  validateFrameworkConfig(config);
  assert.deepEqual(Object.keys(target(config, "service").secrets), ["OPENAI_API_KEY"]);

  // The container's name and the authored variable are separate facts, so a
  // secret can reach a container under a name of its own.
  const renamed = serviceConfig({ MODEL_API_KEY: resources.openaiApiKey });
  validateFrameworkConfig(renamed);
  const entry = target(renamed, "service").secrets.MODEL_API_KEY;
  assert.equal(entry?.fromEnv, "OPENAI_API_KEY");
});

test("a literal in secrets says to name a catalog entry", () => {
  assert.throws(
    () => serviceConfig({ OPENAI_API_KEY: "sk-do-not-do-this" }),
    /Name a secret from the catalog, declared with resource\.secret\(\)/,
  );
});

test("an object that merely looks like a declaration is refused", () => {
  // Recognized by its brand, never by shape.
  assert.throws(
    () => serviceConfig({ OPENAI_API_KEY: { $resource: "not-the-brand", kind: "secret" } }),
    /Name a secret from the catalog/,
  );
});

test("a secret from another catalog is still reported as undeclared", () => {
  // The invariant assertReferencesAreDeclared exists for: a reference that
  // outlived the declaration it came from.
  const elsewhere = defineResources({ other: { apiKey: resource.secret("ELSEWHERE_API_KEY") } });
  assert.throws(
    () => validateFrameworkConfig(serviceConfig({ OPENAI_API_KEY: elsewhere.other.apiKey })),
    /not declared in this config's "resources" catalog/,
  );
});

test("a string resource in secrets says which declaration makes a secret", () => {
  assert.throws(
    () => serviceConfig({ OPENAI_API_KEY: resources.langgraph.modelProvider }),
    /which is a string resource\. Declare it with resource\.secret\(\)/,
  );
});

test("an ARN projection under secrets says to drop the .arn", () => {
  // Startup injection takes the value. Asking for it by ARN is asking for the
  // other delivery, which is an environment entry.
  assert.throws(
    () => serviceConfig({ OPENAI_API_KEY: resources.openaiApiKey.arn }),
    /Startup injection takes the secret itself; drop the "\.arn"/,
  );
});

test("a Lambda declaring startup secrets is sent to the ARN form", () => {
  assert.throws(
    () =>
      defineFrameworkConfig({
        resources,
        defaults,
        http: [
          {
            "/graphql": {
              directory: LAMBDA_DIRECTORY,
              methods: ["POST"],
              auth: true,
              secrets: { OPENAI_API_KEY: resources.openaiApiKey },
            },
          },
        ],
        webSocket: [],
        services: [],
        events: [],
        tasks: [],
        workflows: [],
      } as never),
    /no startup the ECS agent can inject into.*resources\.<secret>\.arn/s,
  );
});

// ---------------------------------------------------------------------------
// Delivering the ARN: a Lambda reads the secret itself
// ---------------------------------------------------------------------------

test("reading .arn injects the name and derives the grant from the same line", () => {
  const config = lambdaConfig({
    PRIMARY_DATABASE_SECRET_ARN: resources.database.credentials.arn,
  });
  validateFrameworkConfig(config);
  const lambda = target(config, "lambda");

  assert.equal(
    lambda.environment.PRIMARY_DATABASE_SECRET_ARN,
    resources.database.credentials.arn,
  );
  const [binding, ...rest] = getSecretBindings(lambda.cloud.bindings);
  assert.deepEqual(rest, []);
  assert.equal(binding?.environment, "PRIMARY_DATABASE_SECRET_ARN");
  // The binding names the secret, because a grant is on a secret.
  assert.equal(binding?.secret.kind, "secret");
  assert.deepEqual(binding?.secret.path, ["database", "credentials"]);
  assert.ok(!binding?.secret.secretArn);
});

test("a bare secret in environment points at .arn rather than being accepted", () => {
  assert.throws(
    () => lambdaConfig({ OPENAI_API_KEY: resources.openaiApiKey }),
    (error: Error) => {
      assert.match(error.message, /A secret's value never belongs in an environment variable/);
      assert.match(error.message, /resources\.openaiApiKey\.arn/);
      return true;
    },
  );
});

test("readSecret\\(\\) as a binding says where the read moved to", () => {
  assert.throws(
    () =>
      defineFrameworkConfig({
        resources,
        defaults,
        http: [
          {
            "/graphql": {
              directory: LAMBDA_DIRECTORY,
              methods: ["POST"],
              auth: true,
              cloud: {
                bindings: [
                  {
                    capability: "readSecret",
                    secret: resources.openaiApiKey,
                    environment: "PRIMARY_DATABASE_SECRET_ARN",
                  },
                ],
              },
            },
          },
        ],
        webSocket: [],
        services: [],
        events: [],
        tasks: [],
        workflows: [],
      } as never),
    /no longer a binding.*resources\.openaiApiKey\.arn/s,
  );
});

test("an absent secret's ARN drops out of the deployment entirely", () => {
  const config = lambdaConfig({
    PRIMARY_DATABASE_SECRET_ARN: withoutDatabase.database.credentials.arn,
  });
  const values = resolveCloudValues(target(config, "lambda"), nothing, "test");
  assert.equal(values.environment.PRIMARY_DATABASE_SECRET_ARN, undefined);
  assert.deepEqual(values.bindings, []);
});

test("a supplied handle resolves to its ARN, and grants read on the handle", () => {
  const config = lambdaConfig({
    PRIMARY_DATABASE_SECRET_ARN: resources.database.credentials.arn,
  });
  const values = resolveCloudValues(
    target(config, "lambda"),
    supplying({ "database.credentials": { secretArn: SYNCED_ARN } }),
    "test",
  );
  assert.equal(values.environment.PRIMARY_DATABASE_SECRET_ARN, SYNCED_ARN);
  assert.deepEqual(values.bindings, [
    { capability: "readSecret", environment: "PRIMARY_DATABASE_SECRET_ARN", secret: { secretArn: SYNCED_ARN } },
  ]);
});

test("an authored secret's ARN reaches a Lambda, alongside the grant to read it", () => {
  // The combination that did not exist before: a value you author in
  // cdk-app/.env, read by a Lambda. What the lane hands back is an address,
  // never the contents — and at this layer the contents are not even in
  // scope. That the value cannot reach a template is proven where the value
  // actually exists, in cdk-app/test/startup-secrets.test.ts.
  const config = lambdaConfig({ OPENAI_API_KEY_ARN: resources.openaiApiKey.arn });
  const values = resolveCloudValues(
    target(config, "lambda"),
    supplying({ openaiApiKey: { secretArn: SYNCED_ARN } }),
    "test",
  );

  assert.equal(values.environment.OPENAI_API_KEY_ARN, SYNCED_ARN);
  assert.deepEqual(values.bindings, [
    { capability: "readSecret", environment: "OPENAI_API_KEY_ARN", secret: { secretArn: SYNCED_ARN } },
  ]);
});

// ---------------------------------------------------------------------------
// Requirements, on the workload that reads the secret
// ---------------------------------------------------------------------------

test("a conditional requirement holds only when its condition does", () => {
  const config = serviceConfig({ OPENAI_API_KEY: resources.openaiApiKey }, [WHEN_OPENAI]);
  const declared = requirements(config, "service");

  // Bedrock: the condition does not hold, so nothing is required.
  assertRequirementsMet(declared, lane({ "langgraph.modelProvider": "bedrock" }), "test:");

  assert.throws(
    () => assertRequirementsMet(declared, lane({ "langgraph.modelProvider": "openai" }), "test:"),
    (error: Error) => {
      assert.match(error.message, /resources\.openaiApiKey is required/);
      assert.match(error.message, /cdk-app\/\.env declares no value for it/);
      assert.match(error.message, /The task reads the key at startup\./);
      assert.match(
        error.message,
        /Set OPENAI_API_KEY in cdk-app\/\.env and run npm run deploy\./,
      );
      return true;
    },
  );
});

test("a supplied secret satisfies its own requirement", () => {
  const config = serviceConfig({ OPENAI_API_KEY: resources.openaiApiKey }, [WHEN_OPENAI]);
  const met = assertRequirementsMet(
    requirements(config, "service"),
    lane({ "langgraph.modelProvider": "openai", openaiApiKey: { secretArn: SYNCED_ARN } }),
    "test:",
  );
  // The evaluator reports what this lane had to supply, which is what the CDK
  // lane uses to decide a secret needs an ARN parameter minted for it.
  assert.deepEqual(met.map((reference) => reference.path), [["openaiApiKey"]]);
});


// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test("a supplied secret resolves to the handle its lane gave it", () => {
  const config = serviceConfig({ OPENAI_API_KEY: resources.openaiApiKey });
  const values = resolveCloudValues(
    target(config, "service"),
    supplying({ openaiApiKey: { secretArn: SYNCED_ARN } }),
    "test",
  );
  assert.deepEqual(values.secrets, {
    OPENAI_API_KEY: { handle: { secretArn: SYNCED_ARN } },
  });
});

test("a secret nothing requires is absent rather than blank", () => {
  // Absent is what the workload's own startup check can tell apart from a key
  // somebody set to an empty string.
  const config = serviceConfig({ OPENAI_API_KEY: resources.openaiApiKey });
  const values = resolveCloudValues(target(config, "service"), nothing, "test");
  assert.deepEqual(values.secrets, {});
});

// ---------------------------------------------------------------------------
// Delivering one key: a container that wants a value, not a document
// ---------------------------------------------------------------------------

test("a field projection is the same secret, narrowed to one key", () => {
  const config = serviceConfig({
    PGPASSWORD: resources.database.credentials.field("password"),
  });
  validateFrameworkConfig(config);
  const entry = target(config, "service").secrets.PGPASSWORD;

  // Still the secret: same path, same kind, so the grant it carries is the
  // one the whole secret would have carried.
  assert.equal(entry?.kind, "secret");
  assert.deepEqual(entry?.path, ["database", "credentials"]);
  assert.equal(entry?.secretField, "password");
});

test("a selected key reaches the resolved secret beside its handle", () => {
  const config = serviceConfig({
    PGUSER: resources.database.credentials.field("username"),
    PGPASSWORD: resources.database.credentials.field("password"),
  });
  const values = resolveCloudValues(
    target(config, "service"),
    supplying({ "database.credentials": { secretArn: SYNCED_ARN } }),
    "test",
  );
  // One handle, two keys: the ECS stack imports the secret once and reads a
  // different field of it per entry.
  assert.deepEqual(values.secrets, {
    PGUSER: { handle: { secretArn: SYNCED_ARN }, field: "username" },
    PGPASSWORD: { handle: { secretArn: SYNCED_ARN }, field: "password" },
  });
});

test("an absent secret's key drops out of the deployment like the secret does", () => {
  const config = serviceConfig({
    PGPASSWORD: withoutDatabase.database.credentials.field("password"),
  });
  const values = resolveCloudValues(target(config, "service"), nothing, "test");
  assert.deepEqual(values.secrets, {});
});

test("an authored secret offers no key at all, because Compose passes the value whole", () => {
  // Not a runtime refusal any more: `.field()` belongs to a secret a stack
  // built, whose document a deployment extracts from. An authored secret
  // reaches a local container exactly as written, so a key would be extracted
  // in AWS and not on your machine — one declaration, two behaviours, which is
  // the thing this framework does not do. The type is what says so.
  // @ts-expect-error an authored secret has no key to take
  void (() => resources.openaiApiKey.field("password"));
  assert.equal(
    (resources.openaiApiKey as unknown as Record<string, unknown>).field,
    undefined,
  );
});

test("a key holding a colon is refused before it reaches the agent", () => {
  // ECS names the field inside the ARN, so a colon would be read as structure.
  assert.throws(
    () => resources.database.credentials.field("pass:word"),
    /names one JSON key/,
  );
  assert.throws(() => resources.database.credentials.field(""), /names one JSON key/);
});

test("a key in environment says a key is still the secret's contents", () => {
  assert.throws(
    () => lambdaConfig({ PGPASSWORD: resources.database.credentials.field("password") }),
    /A key of a secret is still the secret's contents/,
  );
});
