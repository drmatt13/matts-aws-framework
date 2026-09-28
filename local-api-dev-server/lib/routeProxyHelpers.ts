import express from "express";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  getPublicRoutePath,
  routeAllowsMethod,
  type HttpRouteDefinition,
  type LambdaTarget,
} from "@repo/framework/config";
import {
  LocalLambdaExecutor,
  type LambdaInvocationResult,
  type LocalServiceRegistry,
} from "@repo/framework/local";
import {
  AuthUnavailableError,
  getAuthenticatedHttpSession,
} from "@repo/framework/runtime/auth";
import invokeLambdaFunction, { LAMBDA_PAYLOAD_LIMIT_BYTES } from "./invokeLambdaFunction";
import forwardToContainer from "./proxyToContainer";

/** API Gateway's own bodies, so a client sees one shape in both lanes. */
function unauthorized(res: express.Response): void {
  res.status(401).json({ message: "Unauthorized" });
}

function serviceUnavailable(res: express.Response): void {
  res.status(503).json({ message: "Service Unavailable" });
}

function internalServerError(res: express.Response): void {
  if (!res.headersSent) res.status(500).json({ message: "Internal Server Error" });
}

async function getRequestSession(req: express.Request) {
  return getAuthenticatedHttpSession({
    authorizationHeader: req.header("authorization"),
  });
}

/**
 * Matches API Gateway's path matching rather than Express's defaults: a path is
 * case-sensitive and a trailing slash is a different path. Without this a
 * request that works locally can 404 in AWS.
 */
export function applyApiGatewayRouting(app: express.Express): void {
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
}

/**
 * A declaration that matched the path but not the method hands the request on
 * instead of answering it, because a later declaration may own this method at
 * the same path. Whether anything answers at all is decided once, by
 * {@link registerUnmatchedRouteHandler}.
 */
function handledPreflightOrPassedOn(
  route: HttpRouteDefinition,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): boolean {
  if (req.method.toUpperCase() === "OPTIONS") {
    // The CORS middleware answers real preflights first; this covers a bare
    // OPTIONS to a declared path.
    res.status(204).send("");
    return true;
  }
  if (!routeAllowsMethod(route, req.method)) {
    next();
    return true;
  }
  return false;
}

export function registerLambdaRoute(
  app: express.Express,
  route: HttpRouteDefinition,
  target: LambdaTarget,
  executor: LocalLambdaExecutor,
): void {
  app.all(
    route.path,
    // The body reaches the handler as bytes, exactly as API Gateway passes it:
    // no parser decides locally what the handler would have decided in AWS.
    express.raw({ type: () => true, limit: LAMBDA_PAYLOAD_LIMIT_BYTES }),
    async (req, res, next) => {
      if (handledPreflightOrPassedOn(route, req, res, next)) return;

      let session: Awaited<ReturnType<typeof getRequestSession>> | undefined;
      try {
        session = route.auth === true ? await getRequestSession(req) : undefined;
      } catch (error) {
        if (error instanceof AuthUnavailableError) {
          console.error(`[routes] ${error.message}`, error.reason);
          serviceUnavailable(res);
          return;
        }
        console.error(`[routes] Authorizing ${route.path} failed:`, error);
        internalServerError(res);
        return;
      }
      if (route.auth === true && !session) {
        unauthorized(res);
        return;
      }

      try {
        return await invokeLambdaFunction(
          req,
          res,
          (event: APIGatewayProxyEventV2) =>
            executor.invoke(target, event) as Promise<LambdaInvocationResult>,
          {
            authorizerJwtClaims: session?.payload ?? undefined,
            routeKey: `${req.method.toUpperCase()} ${route.path}`,
          },
        );
      } catch (error) {
        // The handler's own stack: the child process sends it with the error.
        console.error(`[${target}] Invocation failed:`, error);
        internalServerError(res);
      }
    },
  );
}

/** Register config-owned routing; an unavailable Compose upstream answers 502. */
export function registerServiceRoute(
  app: express.Express,
  route: HttpRouteDefinition,
  registry: LocalServiceRegistry,
): void {
  if (route.type !== "service") {
    throw new Error(`Expected a service target, received "${route.type}:${route.target}".`);
  }
  const mountPath = getPublicRoutePath(route.path);

  app.use(mountPath, async (req, res, next) => {
    if (handledPreflightOrPassedOn(route, req, res, next)) return;

    const serviceUrl = registry.getEndpoint(route.target);
    if (!serviceUrl) {
      console.warn(
        `[routes] ${req.method} ${req.originalUrl} targets service "${route.target}", which is not running. Check docker compose ps.`,
      );
      next();
      return;
    }

    try {
      const session = route.auth === true ? await getRequestSession(req) : undefined;
      if (route.auth === true && !session) {
        unauthorized(res);
        return;
      }
      await forwardToContainer(req, res, serviceUrl, mountPath);
    } catch (error) {
      if (error instanceof AuthUnavailableError) {
        serviceUnavailable(res);
        return;
      }
      console.error(`Local service proxy error for ${route.target}:`, error);
      if (!res.headersSent) {
        res.status(502).json({
          error: "Bad gateway",
          message: error instanceof Error ? error.message : "Unknown proxy error",
        });
      } else {
        res.destroy();
      }
    }
  });
}

/**
 * The last word on a request no declaration claimed.
 *
 * API Gateway answers an unmatched path *and* an unmatched method on a matched
 * path with the same 404, so this does too rather than inheriting an Express
 * 405 that AWS would never send. The near miss is logged instead, where it
 * helps the developer without changing what the client sees.
 */
export function registerUnmatchedRouteHandler(
  app: express.Express,
  routes: readonly HttpRouteDefinition[],
): void {
  app.use((req, res) => {
    const declaredMethods = routes
      .filter((route) => route.path === req.path)
      .flatMap((route) => (route.methods === "*" ? ["ANY"] : [...route.methods]));
    if (declaredMethods.length > 0) {
      console.warn(
        `[routes] ${req.method} ${req.path} is not declared; ${req.path} serves ${declaredMethods.join(", ")}.`,
      );
    }
    res.status(404).json({ message: "Not Found" });
  });
}

/**
 * The last word on a request that failed before any handler answered it: a
 * body over Lambda's payload limit, or an unexpected error. Registered after
 * everything else, and answering in API Gateway's JSON rather than Express's
 * HTML error page.
 */
export function registerApiGatewayErrorHandler(app: express.Express): void {
  app.use(
    (
      error: { type?: string; status?: number },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      if (error.type === "entity.too.large" || error.status === 413) {
        res.status(413).json({ message: "Request Entity Too Large" });
        return;
      }
      console.error("[routes] Request failed:", error);
      res.status(500).json({ message: "Internal Server Error" });
    },
  );
}
