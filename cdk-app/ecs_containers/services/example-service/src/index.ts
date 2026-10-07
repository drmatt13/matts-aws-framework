import express from "express";
import { z } from "zod";
import {
  AuthUnavailableError,
  getAuthenticatedHttpSession,
  type AuthenticatedCognitoSession,
} from "@repo/framework/runtime/auth";

/**
 * A minimal Express service: one public health check and two authenticated
 * routes. Mounted at /example-service, so the browser calls
 * /api/example-service/hello and the proxy in front strips the mount before
 * the request arrives here as /hello.
 */

const PORT = process.env.PORT || 5000;

const app = express();
app.use(express.json());

/* ------------------------------------------------------------
 * Authentication
 * ------------------------------------------------------------
 * The route is declared `auth: true`, so the API in front of this
 * service already refuses a request without a valid token. This
 * middleware verifies the ID token again so the service never
 * depends on one boundary alone.
 * ------------------------------------------------------------ */

type Authenticated = { session: AuthenticatedCognitoSession };

async function authMiddleware(
  req: express.Request,
  res: express.Response<unknown, Authenticated>,
  next: express.NextFunction,
): Promise<void> {
  try {
    const session = await getAuthenticatedHttpSession({
      authorizationHeader: req.header("authorization") ?? null,
    });

    if (!session) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    res.locals.session = session;
    next();
  } catch (error) {
    console.error("auth error", error);
    if (error instanceof AuthUnavailableError) {
      res.status(503).json({ message: "Service Unavailable" });
      return;
    }
    res.status(500).json({ message: "Auth service is not configured" });
  }
}

/* ------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------ */

// Unauthenticated on purpose: the load balancer's health check cannot
// present a Cognito token.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Who the verified token says the caller is.
app.get("/hello", authMiddleware, (_req, res: express.Response<unknown, Authenticated>) => {
  const { sub, email } = res.locals.session.payload;
  res.json({ message: `Hello, ${typeof email === "string" ? email : sub}!`, sub });
});

const GreetBody = z.object({ name: z.string().trim().min(1).max(100) });

// A JSON body, validated before it is used.
app.post("/greet", authMiddleware, (req, res) => {
  const body = GreetBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "name is required (1 to 100 characters)." });
    return;
  }
  res.json({ greeting: `Hello, ${body.data.name}!`, at: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Example service listening on ${PORT}`);
});
