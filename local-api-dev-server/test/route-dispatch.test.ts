import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  getAllHttpRoutes,
  toTargetReference,
  validateFrameworkConfig,
  type FrameworkConfig,
  type LambdaTarget,
} from "@repo/framework/config";
import {
  LocalServiceRegistry,
  type LocalLambdaExecutor,
} from "@repo/framework/local";
import {
  applyApiGatewayRouting,
  registerApiGatewayErrorHandler,
  registerLambdaRoute,
  registerServiceRoute,
  registerUnmatchedRouteHandler,
} from "../lib/routeProxyHelpers";
import {
  LAMBDA_PAYLOAD_LIMIT_BYTES,
  toApiGatewayJwtClaims,
} from "../lib/invokeLambdaFunction";

/**
 * Local dispatch has to pick a binding by path *and* method, because the
 * deployed API does. A Lambda that owns `POST /orders` must not swallow the
 * `GET /orders` a service mount owns, and an unmatched method has to answer the
 * way API Gateway answers it.
 */

const config: FrameworkConfig = {
  defaults: {
    lambda: {
      runtime: "nodejs24",
      packaging: "zip",
      architecture: "arm64",
      memorySize: 128,
      timeoutSeconds: 10,
      bundling: { minify: true, sourceMap: true },
    },
  },
  http: {
    "/orders": {
      directory: "/lambda_functions/orders-create",
      methods: ["POST"],
    },
    "/verify": { directory: "/lambda_functions/verify", methods: ["GET"] },
    "/secret": {
      directory: "/lambda_functions/secret",
      methods: ["GET"],
      auth: true,
    },
  },
  webSocket: {},
  events: {},
  services: {
    "/orders/*": {
      directory: "/ecs_containers/services/orders",
      methods: ["GET"],
    },
  },
};

interface Invocation {
  readonly target: LambdaTarget;
  readonly event: APIGatewayProxyEventV2;
}

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "dev-server-routes-"));
  mkdirSync(path.join(root, "cdk-app", "lambda_functions"), { recursive: true });
  writeFileSync(path.join(root, "framework.config.ts"), "export default {};\n");
  writeFileSync(
    path.join(root, "docker-compose.yml"),
    "services:\n  orders:\n    image: orders\n",
  );
  const service = path.join(root, "cdk-app", "ecs_containers", "services", "orders");
  mkdirSync(service, { recursive: true });
  writeFileSync(path.join(service, "Dockerfile"), "FROM scratch\nEXPOSE 8000\n");
  return root;
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected a TCP address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

/** Boots the dev server's real route registration over stub targets. */
async function withDevServer(
  run: (context: {
    readonly url: string;
    readonly invocations: readonly Invocation[];
    readonly upstream: readonly string[];
  }) => Promise<void>,
): Promise<void> {
  const root = fixtureRoot();
  const invocations: Invocation[] = [];
  const upstream: string[] = [];

  const upstreamServer = createServer((request, response) => {
    upstream.push(request.url ?? "");
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ seen: request.url }));
  });
  const upstreamUrl = await listen(upstreamServer);

  const registry = new LocalServiceRegistry({ config, repositoryRoot: root, environment: { ORDERS_SERVICE_URL: upstreamUrl } });

  const executor = {
    invoke: async (target: LambdaTarget, event: unknown) => {
      invocations.push({ target, event: event as APIGatewayProxyEventV2 });
      if ((event as APIGatewayProxyEventV2).body === "boom") {
        throw new Error("handler failed");
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    },
  } as unknown as LocalLambdaExecutor;

  const app = express();
  applyApiGatewayRouting(app);

  validateFrameworkConfig(config);
  const routes = getAllHttpRoutes(config);
  for (const route of routes) {
    if (route.type === "lambda") {
      registerLambdaRoute(
        app,
        route,
        toTargetReference("lambda", route.target) as LambdaTarget,
        executor,
      );
    } else {
      registerServiceRoute(app, route, registry);
    }
  }
  registerUnmatchedRouteHandler(app, routes);
  registerApiGatewayErrorHandler(app);

  const browserApp = express();
  applyApiGatewayRouting(browserApp);
  browserApp.use("/api", app);
  const server = createServer(browserApp);
  const url = (await listen(server)) + "/api";
  try {
    await run({ url, invocations, upstream });
  } finally {
    await close(server);
    await close(upstreamServer);
    rmSync(root, { recursive: true, force: true });
  }
}

test("a method mismatch falls through to the binding that owns it", async () => {
  await withDevServer(async ({ url, invocations, upstream }) => {
    // The Lambda is registered first and owns only POST; GET has to reach the
    // service mount registered after it.
    const posted = await fetch(`${url}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: "book" }),
    });
    assert.equal(posted.status, 200);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].target, "lambda:orders-create");

    const listed = await fetch(`${url}/orders`);
    assert.equal(listed.status, 200);
    assert.equal(invocations.length, 1);
    assert.deepEqual(upstream, ["/"]);

    // The mount keeps stripping its public prefix, query string included.
    const nested = await fetch(`${url}/orders/123?expand=items`);
    assert.equal(nested.status, 200);
    assert.deepEqual(upstream, ["/", "/123?expand=items"]);
  });
});

test("builds an API Gateway payload format 2.0 event", async () => {
  await withDevServer(async ({ url, invocations }) => {
    await fetch(`${url}/orders?draft=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: "book" }),
    });

    const { event } = invocations[0];
    assert.equal(event.version, "2.0");
    // The route key is the declared path, not the request's own path.
    assert.equal(event.routeKey, "POST /orders");
    assert.equal(event.rawPath, "/orders");
    assert.equal(event.rawQueryString, "draft=true");
    assert.equal(event.requestContext.http.method, "POST");
    assert.equal(event.body, JSON.stringify({ item: "book" }));
  });
});

test("answers an undeclared method the way API Gateway does", async () => {
  await withDevServer(async ({ url, invocations }) => {
    for (const method of ["DELETE", "HEAD"]) {
      const response = await fetch(`${url}/orders`, { method });
      assert.equal(response.status, 404, `${method} /orders`);
    }
    // HEAD is answered explicitly rather than inherited from a GET binding.
    assert.equal((await fetch(`${url}/verify`, { method: "HEAD" })).status, 404);
    assert.equal((await fetch(`${url}/verify`)).status, 200);

    const missing = await fetch(`${url}/nowhere`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { message: "Not Found" });
    assert.equal(invocations.length, 1);
  });
});

test("matches paths the way API Gateway matches them", async () => {
  await withDevServer(async ({ url, invocations }) => {
    // Case is significant, and a trailing slash is a different path.
    assert.equal((await fetch(`${url}/Verify`)).status, 404);
    assert.equal((await fetch(`${url}/verify/`)).status, 404);
    assert.equal(invocations.length, 0);
  });
});

test("keeps auth on the binding that declares it", async () => {
  await withDevServer(async ({ url, invocations }) => {
    const denied = await fetch(`${url}/secret`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { message: "Unauthorized" });
    // The handler is never reached without a verified session.
    assert.equal(invocations.length, 0);

    // A declared path still answers preflight without authenticating it.
    assert.equal((await fetch(`${url}/secret`, { method: "OPTIONS" })).status, 204);
  });
});

test("a declared service without an upstream answers 502 without any snapshot", async () => {
  // A fresh clone, or a config edit that added a service: the containers do not
  // exist yet, so the route answers the way an undeclared path does rather than
  // advertising a mount that cannot be reached.
  const root = fixtureRoot();
  try {
    const registry = new LocalServiceRegistry({ config, repositoryRoot: root, environment: { ORDERS_SERVICE_URL: "http://127.0.0.1:1" } });
    const app = express();
    applyApiGatewayRouting(app);
    const routes = getAllHttpRoutes(config);
    for (const route of routes) {
      if (route.type === "service") registerServiceRoute(app, route, registry);
    }
    registerUnmatchedRouteHandler(app, routes);

    const server = createServer(app);
    const url = await listen(server);
    try {
      const response = await fetch(`${url}/orders/123`);
      assert.equal(response.status, 502);
      assert.equal((await response.json() as { error: string }).error, "Bad gateway");
    } finally {
      await close(server);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the body reaches the handler as API Gateway passes it", async () => {
  await withDevServer(async ({ url, invocations }) => {
    // Larger than body-parser's 100 KB JSON default, which used to answer 413
    // locally for a request AWS would deliver.
    const large = JSON.stringify({ text: "x".repeat(200_000) });
    const posted = await fetch(`${url}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: large,
    });
    assert.equal(posted.status, 200);
    assert.equal(invocations[0].event.body, large);

    // Malformed JSON is the handler's to judge, not the dev server's.
    await fetch(`${url}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(invocations[1].event.body, "{not json");
  });
});

test("cookies arrive one per entry, as API Gateway splits them", async () => {
  await withDevServer(async ({ url, invocations }) => {
    await fetch(`${url}/orders`, {
      method: "POST",
      headers: { cookie: "theme=dark; refreshToken=abc" },
      body: "{}",
    });
    assert.deepEqual(invocations[0].event.cookies, ["theme=dark", "refreshToken=abc"]);
  });
});

test("failures answer in API Gateway's JSON, not an HTML error page", async () => {
  await withDevServer(async ({ url }) => {
    const failed = await fetch(`${url}/orders`, { method: "POST", body: "boom" });
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { message: "Internal Server Error" });

    const tooLarge = await fetch(`${url}/orders`, {
      method: "POST",
      body: "x".repeat(LAMBDA_PAYLOAD_LIMIT_BYTES + 1),
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { message: "Request Entity Too Large" });
  });
});

test("JWT claims are strings, as API Gateway's authorizer delivers them", () => {
  assert.deepEqual(
    toApiGatewayJwtClaims({
      sub: "user",
      exp: 1700000000,
      email_verified: true,
      "cognito:groups": ["admin", "staff"],
    }),
    {
      sub: "user",
      exp: "1700000000",
      email_verified: "true",
      "cognito:groups": "[admin staff]",
    },
  );
});
