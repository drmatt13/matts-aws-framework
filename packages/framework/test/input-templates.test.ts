import { applicationVpc as fixtureVpc } from "../../../framework-config/networks/application";
import assert from "node:assert/strict";
import test from "node:test";
import { defineFrameworkConfig, defineResources, resource, type DeploySetting } from "../src/config";
import { undocumentedRequiredInputs, type InputTemplate } from "../scripts/check-repository";
import { defaults } from "../../../framework-config/defaults";

const resources = defineResources({
  apiKey: resource.secret("PARTNER_API_KEY"),
  mode: resource.fromEnv("PARTNER_MODE").enum("live", "sandbox").default("sandbox"),
  region: resource.fromEnv("PARTNER_REGION"),
  model: resource.fromEnv("PARTNER_MODEL").default("small"),
});

/** One route reading every input, requiring the key when the mode is live. */
function config(deploy: DeploySetting, requirements = true) {
  return defineFrameworkConfig({ networks: [fixtureVpc],
    resources, defaults, webSocket: [], events: [], services: [],
    http: [{
      "/partner": {
        directory: "/lambda_functions/http_functions/partner",
        methods: ["POST"],
        deploy,
        environment: { MODE: resources.mode, REGION: resources.region, MODEL: resources.model, KEY_ARN: resources.apiKey.arn },
        ...(requirements
          ? { cloud: { requirements: [{ when: { resource: resources.mode, equals: "live" }, require: [resources.apiKey], message: "Live calls are signed with it." }] } }
          : {}),
      },
    }],
  } as never);
}
const templates = (dev: string, prod: string): InputTemplate[] => [
  { file: "dev.example", graph: "dev", text: dev },
  { file: "prod.example", graph: "prod", text: prod },
];
const files = (problems: readonly string[]) => problems.map((problem) => problem.split(" ")[0]);

test("an optional input, a defaulted one or a secret nothing requires is never demanded", () => {
  assert.deepEqual(undocumentedRequiredInputs(config("both", false), templates("", "")), []);
});

test("a required input is named, with its condition, in each template whose graph runs the workload", () => {
  const problems = undocumentedRequiredInputs(config("both"), templates("", ""));
  assert.deepEqual(files(problems), ["dev.example", "prod.example"]);
  assert.match(
    problems[0]!,
    /^dev\.example does not list PARTNER_API_KEY, which http\["\/partner"\] requires\. Add:\n  # Required when PARTNER_MODE is live: Live calls are signed with it\.\n  PARTNER_API_KEY=$/,
  );
  // Listed, set or commented, is enough; only the required input was ever asked for.
  assert.deepEqual(undocumentedRequiredInputs(config("both"), templates("# PARTNER_API_KEY=", "PARTNER_API_KEY=")), []);
});

test("a requirement belongs only to the templates of the graphs that run its workload", () => {
  assert.deepEqual(files(undocumentedRequiredInputs(config("cloud-only"), templates("", ""))), ["prod.example"]);
  assert.deepEqual(files(undocumentedRequiredInputs(config("local-only"), templates("", ""))), ["dev.example"]);
  assert.deepEqual(undocumentedRequiredInputs(config("none"), templates("", "")), []);
});

test("a name is matched as a whole assignment, not as part of another", () => {
  const near = "PARTNER_API_KEY_OLD=\nOLD_PARTNER_API_KEY=";
  assert.deepEqual(files(undocumentedRequiredInputs(config("both"), templates(near, near))), ["dev.example", "prod.example"]);
});

test("an input required only in production is demanded only from the production template, whichever graph is loaded", () => {
  const scoped = defineResources({ region: resource.fromEnv("PARTNER_REGION").required("prod") }, { mode: "dev" });
  const problems = undocumentedRequiredInputs(defineFrameworkConfig({ networks: [fixtureVpc], resources: scoped, defaults, webSocket: [], events: [], services: [],
    http: [{ "/partner": { directory: "/lambda_functions/http_functions/partner", methods: ["POST"], environment: { REGION: scoped.region } } }] } as never), templates("", ""));
  assert.deepEqual(files(problems), ["prod.example"]);
  assert.deepEqual(undocumentedRequiredInputs(defineFrameworkConfig({ networks: [fixtureVpc], resources: scoped, defaults, webSocket: [], events: [], services: [],
    http: [{ "/partner": { directory: "/lambda_functions/http_functions/partner", methods: ["POST"], environment: { REGION: scoped.region } } }] } as never), templates("", "# PARTNER_REGION=\n")), []);
});
