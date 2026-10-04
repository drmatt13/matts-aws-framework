import {
  getAgentLifecycle,
  getAgentTools,
  getFrameworkTargets,
  isTargetDeployed,
  type FrameworkConfig,
} from "@repo/framework/config";
import framework from "../../../framework.config";

/**
 * What each agent is, printed: where it runs, who can call it, and the Gateway
 * the framework derives from its tools.
 *
 * Read-only and offline: it reads the declarations, not a deployment, and makes
 * no AWS call. `npm run agents:inspect` prints every agent;
 * `npm run agents:inspect -- <id>` prints one.
 */

const GREY = "\u001b[90m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";
const colour = process.stdout.isTTY === true;
const dim = (text: string) => (colour ? `${GREY}${text}${RESET}` : text);
const bold = (text: string) => (colour ? `${BOLD}${text}${RESET}` : text);

function describe(config: FrameworkConfig, id: string): string[] {
  const target = getFrameworkTargets(config).find((candidate) => candidate.reference === `agent:${id}`)!;
  const declaration = config.agents?.[id];
  const lifecycle = getAgentLifecycle(config, id);
  const lanes = [
    target.deploy === "both" || target.deploy === "local-only" ? "local session processes" : undefined,
    isTargetDeployed(config, "agent", id, "prod") ? "AgentCore Runtime in a full deployment" : undefined,
  ].filter((lane): lane is string => lane !== undefined);

  const lines = [
    bold(`agent:${id}`),
    `  source      ${target.directory}/index.ts`,
    `  runs        ${lanes.length > 0 ? lanes.join("; ") : "nowhere (deploy: none)"}`,
    `  callers     ${
      declaration?.auth === true
        ? (declaration.route ? `the browser at ${declaration.route} with the user's session; ` : "") + "workloads declaring invokesAgent pass the user's session"
        : "workloads declaring invokesAgent, with their own IAM role"
    }`,
    `  sessions    idle ${lifecycle.idleSeconds}s, at most ${lifecycle.maxLifetimeSeconds}s`,
  ];
  const tools = getAgentTools(config, id);
  if (tools.length === 0) {
    lines.push(`  gateway     ${dim("none — the agent declares no tools")}`);
  } else {
    lines.push(`  gateway     its own, holding ${tools.length} tool${tools.length === 1 ? "" : "s"}; emulated locally by the runner`);
    for (const tool of tools) {
      lines.push(
        `    ${tool.id.padEnd(24)} ${tool.auth ? "acts as the signed-in user" : "service authority"}  ${dim(`wire name ${tool.wireName}`)}`,
      );
    }
  }
  return lines;
}

const requested = process.argv[2];
const ids = Object.keys(framework.agents ?? {}).filter((id) => requested === undefined || id === requested);
if (requested !== undefined && ids.length === 0) {
  console.error(`No agent "${requested}". Declared: ${Object.keys(framework.agents ?? {}).join(", ") || "none"}.`);
  process.exitCode = 1;
}
console.log(ids.map((id) => describe(framework, id).join("\n")).join("\n\n"));
