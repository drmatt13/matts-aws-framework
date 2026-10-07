import express from "express";
import { randomUUID } from "crypto";
import {
  AuthUnavailableError,
  getAuthenticatedHttpSession,
} from "@repo/framework/runtime/auth";
import {
  invoke,
  streamAssistant,
  getHistory,
  getThread,
  extractText,
  checkInterrupt,
  NoPendingInterruptError,
} from "./graph";

const PORT = process.env.PORT || 5000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const app = express();
app.use(express.json());

/* ------------------------------------------------------------
 * Authentication
 * ------------------------------------------------------------
 * The graph reaches Bedrock, so an open endpoint here is an open
 * path to paid inference. The load balancer in front of this
 * service is internal and reached through the authorized API route,
 * but this middleware verifies the ID token itself so the service
 * never depends on one boundary alone.
 * ------------------------------------------------------------ */

async function authMiddleware(
  req: express.Request,
  res: express.Response,
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

    res.locals.authSession = session;
    next();
  } catch (error) {
    console.error("auth error", error);
    if (error instanceof AuthUnavailableError) {
      res.status(503).json({ message: "Service Unavailable" });
      return;
    }
    res.status(500).json({
      ok: false,
      error: "Auth service is not configured",
    });
  }
}

// Unauthenticated on purpose: the load balancer target group health check
// cannot present a Cognito token.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/* ------------------------------------------------------------
 * Shared request parsing
 * ------------------------------------------------------------ */

type ChatBody = {
  message: string;
  threadId: string;
  resume: boolean;
};

// Pulls the common {message, threadId, resume} shape off a request body.
// `threadId` is generated when omitted, since a new conversation has no
// thread yet; every endpoint below shares this so behavior stays consistent.
function parseChatBody(req: express.Request): ChatBody | { error: string } {
  const message: unknown = req.body?.message;
  if (typeof message !== "string" || !message) {
    return { error: "message is required" };
  }

  const resume = req.body?.resume === true;
  const threadId: string =
    typeof req.body?.threadId === "string" && req.body.threadId
      ? req.body.threadId
      : randomUUID();

  if (resume && !req.body?.threadId) {
    return { error: "threadId is required to resume an interrupted thread" };
  }

  return { message, threadId, resume };
}

// `resume: true` on a thread with no pending interrupt() is a client mistake,
// not a server failure -- surface it as 409, not 500.
function respondToError(res: express.Response, error: unknown) {
  if (error instanceof NoPendingInterruptError) {
    return res.status(409).json({ ok: false, error: error.message });
  }
  return res.status(500).json({
    ok: false,
    error: error instanceof Error ? error.message : "unknown error",
  });
}

/* ------------------------------------------------------------
 * 1. /chat — final message only. What most UIs want.
 * ------------------------------------------------------------ */

app.post("/chat", authMiddleware, async (req, res) => {
  try {
    const parsed = parseChatBody(req);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { message, threadId, resume } = parsed;

    const result = await invoke(message, threadId, resume);

    const interrupt = checkInterrupt(result);
    if (interrupt !== undefined) {
      return res.json({ ok: true, threadId, interrupted: true, interrupt });
    }

    return res.json({
      ok: true,
      threadId,
      interrupted: false,
      message: extractText(result.messages.at(-1)?.content),
    });
  } catch (error) {
    console.error("chat error", error);
    return respondToError(res, error);
  }
});

/* ------------------------------------------------------------
 * 2. /chat/stream — the last message, streamed token by token
 *    over SSE. Use for a live typing effect in the UI.
 * ------------------------------------------------------------ */

app.post("/chat/stream", authMiddleware, async (req, res) => {
  const parsed = parseChatBody(req);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });
  const { message, threadId, resume } = parsed;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    for await (const delta of streamAssistant(message, threadId, resume)) {
      send("delta", { delta });
    }
    send("done", { threadId });
  } catch (error) {
    console.error("chat stream error", error);
    send("error", {
      error: error instanceof Error ? error.message : "unknown error",
    });
  } finally {
    res.end();
  }
});

/* ------------------------------------------------------------
 * 3. /chat/history/:threadId — read-only. Returns the thread's
 *    transcript and current status straight from the
 *    checkpointer. No model call, nothing appended, safe to
 *    poll or refresh. Use it to rehydrate a UI on page load.
 * ------------------------------------------------------------ */

app.get("/chat/history/:threadId", authMiddleware, async (req, res) => {
  try {
    // Express types a route param as possibly absent or repeated.
    const threadId = req.params.threadId;
    if (typeof threadId !== "string" || !threadId) {
      return res.status(400).json({ ok: false, error: "threadId is required" });
    }

    const { exists, ...thread } = await getThread(threadId);

    if (!exists) {
      return res.status(404).json({
        ok: false,
        error: `Thread "${threadId}" not found.`,
      });
    }

    return res.json({ ok: true, threadId, ...thread });
  } catch (error) {
    console.error("chat history error", error);
    return respondToError(res, error);
  }
});

/* ------------------------------------------------------------
 * 4. /chat/debug — development only. Unlike /chat/history this
 *    *runs* a turn, then returns the raw graph state plus every
 *    checkpoint for the thread: each tool call, each
 *    intermediate message, each superstep.
 *
 *    Not registered in production: it dumps the full internal
 *    state of a thread, which is a debugging aid rather than
 *    something to expose from a deployed task.
 * ------------------------------------------------------------ */

if (!IS_PRODUCTION) {
  app.post("/chat/debug", authMiddleware, async (req, res) => {
    try {
      const parsed = parseChatBody(req);
      if ("error" in parsed)
        return res.status(400).json({ error: parsed.error });
      const { message, threadId, resume } = parsed;

      const result = await invoke(message, threadId, resume);
      const history = await getHistory(threadId);

      return res.json({ ok: true, threadId, result, history });
    } catch (error) {
      console.error("chat debug error", error);
      return respondToError(res, error);
    }
  });
}

app.listen(PORT, () => {
  console.log(`LangGraph service listening on ${PORT}`);
});
