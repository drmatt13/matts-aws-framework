import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ModelTarget } from "../../shared/model";
import { assertCreationFile } from "./creation";
import { EditError } from "./io";

import { assertWorkspaceDirectory } from "./workspace";

/** Only missing files at the declaration's actual path. Existing bytes have no replacement path. */
export function planImplementation(root: string, target: ModelTarget): Map<string, string> {
  if (!target.directory || target.kind === "workflow") throw new EditError(422, "This declaration has no implementation directory.");
  const directory = target.kind === "agent" ? target.directory.slice(1) : `cdk-app${target.directory}`;
  const files = new Map<string, string>();
  const add = (name: string, text: string) => {
    if (name === "package.json") assertWorkspaceDirectory(root, directory);
    const file = assertCreationFile(root, `${directory}/${name}`);
    if (!existsSync(file)) files.set(file, text);
  };
  if (target.kind === "agent") {
    add("contract.ts", 'import { z } from "zod";\nexport const contract = { request: z.object({ message: z.string().min(1).max(8000) }), response: z.object({ text: z.string() }) } as const;\n');
    add("index.ts", `import { agent } from "@repo/framework/runtime/agentcore";\nimport { contract } from "./contract";\nexport const handler = agent(${JSON.stringify(target.id)}, contract).respond(async input => ({ text: input.message }));\n`);
    const framework = JSON.parse(readFileSync(path.join(root, "packages/framework/package.json"), "utf8"));
    add("package.json", JSON.stringify({ name: `@repo/${target.id}`, private: true, scripts: { typecheck: "tsc --noEmit" }, dependencies: { "@repo/framework": "*", zod: framework.dependencies.zod } }, null, 2) + "\n");
    add("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, types: ["node"], skipLibCheck: true }, include: ["*.ts"] }, null, 2) + "\n");
  } else if (target.compute.kind === "container") {
    const service = target.kind === "service";
    const port = target.compute.port ?? 5000;
    add("index.mjs", service ? `import { createServer } from "node:http";\ncreateServer((request,response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(request.url === "/health" ? { status: "ok" } : { message: "Ready" })); }).listen(${port}, "0.0.0.0");\n` : 'const input = JSON.parse(process.env.FRAMEWORK_TASK_INPUT ?? "{}");\nif (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Task input must be an object.");\nconsole.log("Task completed");\n');
    add("Dockerfile", `FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY ${directory}/index.mjs ./index.mjs\nUSER node\n${service ? `EXPOSE ${port}\n` : ""}CMD ["node", "index.mjs"]\n`);
    if (service) add("package.json", JSON.stringify({ name: `@repo/${target.id}`, private: true, scripts: { dev: "node --watch index.mjs" } }, null, 2) + "\n");
  } else if (target.compute.kind === "lambda") {
    const compute = target.compute;
    if (compute.packaging === "container") throw new EditError(422, "An image Lambda needs a compatible runtime Dockerfile and handler. Existing code is preserved; implement the image at the configured source link, then refresh. Studio's repair currently supports Node/Python ZIP handlers and ECS images.");
    if (compute.implementation === "python") {
      if (target.auth) throw new EditError(422, "Authenticated Python handlers need their source-owned token verifier. Open the implementation and restore that verifier; Studio will not substitute an unauthenticated starter.");
      if (compute.handler !== "lambda_function.lambda_handler") throw new EditError(422, "Custom Python entry points remain source-owned. Create lambda_function.py and the configured callable in your editor.");
      add("lambda_function.py", 'def lambda_handler(event, context):\n    return {"statusCode": 200, "body": "Ready"}\n');
    } else {
      const handler = compute.handler ?? "lambdaHandler";
      if (!/^[A-Za-z_$][\w$]*$/.test(handler)) throw new EditError(422, "Create the custom handler entry point in source.");
      if (target.role === "tool") {
        add("contract.ts", 'import { z } from "zod";\nexport const contract = { description: "Return the supplied message.", request: z.object({ message: z.string().min(1).max(8000) }), response: z.object({ message: z.string() }) } as const;\n');
        add("index.ts", `import { ${target.auth ? "authenticatedTool" : "tool"} } from "@repo/framework/runtime/tools";\nimport { contract } from "./contract";\nexport const ${handler} = ${target.auth ? "authenticatedTool" : "tool"}(contract, async input => ({ message: input.message }));\n`);
      } else {
        let imports = 'import { jsonResponse } from "@repo/framework/runtime/http";\n';
        let body = target.role === "http" ? 'async () => jsonResponse(200, { message: "Ready" })' : 'async (_input: unknown) => ({ statusCode: 200, body: "Ready" })';
        if (target.role === "http" && target.auth && target.userPool) { imports += 'import { authenticated } from "@repo/framework/runtime/auth";\n'; body = 'authenticated(async (_event, session) => jsonResponse(200, { message: "Ready", userId: session.payload.sub }))'; }
        if (compute.localReplay) { imports += 'import { withLocalReplay } from "@repo/framework/runtime/event-replay";\n'; body = `withLocalReplay(${body})`; }
        add("index.ts", `${imports}\nexport const ${handler} = ${body};\n`);
      }
    }
  }
  if (!files.size) throw new EditError(422, "All starter files already exist. Existing code was preserved; inspect its diagnostics or continue in source.");
  return files;
}
