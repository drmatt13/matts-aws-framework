import { cx } from "../../ui/classes";
import { Send } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

/**
 * One WebSocket connection panel, ported from ws-tester/src/components/WebSocketTester.tsx.
 * The connection lifecycle, payload handling and message log are ws-tester's own; only
 * the presentation follows Studio. The browser opens the socket itself, so a server that
 * checks the Origin header must trust this page's origin.
 */

const ReactJsonView = lazy(() => import("@microlink/react-json-view"));

// ws-tester validated with parse-json, which differs from JSON.parse only in its error message.
const isValidJson = (str: string): boolean => {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
};

function isValidURL(str: string) {
  try {
    new URL(str); // Throws if the URL is invalid
    return true;
  } catch {
    return false;
  }
}

type LifecycleMessage = {
  connectionEvent?: boolean;
  disconnectionEvent?: boolean;
  failedConnectionEvent?: boolean;
};

const isLifecycleMessage = (value: unknown): value is LifecycleMessage => {
  return typeof value === "object" && value !== null;
};

const normalizeMessageForJsonView = (value: unknown) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    return value as object;
  }

  return { value };
};

/** The message viewer's theme follows Studio's: ws-tester's ocean on dark, the default on light. */
const darkScheme = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
function subscribeScheme(change: () => void) {
  const query = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
  query?.addEventListener?.("change", change);
  return () => query?.removeEventListener?.("change", change);
}

export interface WebSocketTesterProps {
  readonly title: string;
  readonly description: string;
  readonly initialConnectionURL: string;
}

const connectionUrlClasses = "h-full min-h-0 min-w-0 flex-1 rounded-md border bg-sheet px-3 py-0 font-mono text-caption leading-none placeholder:text-faint placeholder:opacity-100";
const connectionButtonClasses = {
  connect: "bg-accept text-paper enabled:hover:bg-[color-mix(in_srgb,var(--accept)_85%,var(--ink))] border-transparent",
  disconnect: "bg-refuse text-paper enabled:hover:bg-[color-mix(in_srgb,var(--refuse)_85%,var(--ink))] border-transparent",
  unavailable: "border-rule-strong bg-wash text-faint",
} as const;

export function WebSocketTester({ title, description, initialConnectionURL }: WebSocketTesterProps) {
  const [mounted, setMounted] = useState(false);
  const [wsUrl, setWsUrl] = useState(initialConnectionURL);
  const [URLisValid, setURLisValid] = useState(false);
  const [payload, setPayload] = useState("");
  const [validPayload, setValidPayload] = useState(false);
  const [hasScrollbar, setHasScrollbar] = useState(false);
  const dark = useSyncExternalStore(subscribeScheme, darkScheme, () => true);
  const id = useId();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<unknown[]>([]);

  const [ws, setWs] = useState<WebSocket | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const connectionAttemptRef = useRef(0);
  const [loadingConnection, setLoadingConnection] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isValidURL(wsUrl)) {
      setURLisValid(true);
    } else {
      setURLisValid(false);
    }
  }, [wsUrl]);

  // Check for scrollbar in textarea
  useEffect(() => {
    const checkScrollbar = () => {
      if (textareaRef.current) {
        const { scrollHeight, clientHeight } = textareaRef.current;
        setHasScrollbar(scrollHeight > clientHeight);
      }
    };

    checkScrollbar();
    window.addEventListener("resize", checkScrollbar);

    return () => {
      window.removeEventListener("resize", checkScrollbar);
    };
  }, []);

  useEffect(() => {
    if (isValidJson(payload)) {
      setValidPayload(true);
    } else {
      setValidPayload(false);
    }
  }, [payload]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  const handleIconClick = useCallback(() => {
    if (ws) {
      ws.send(payload);
    }
  }, [ws, payload]);

  // disconnect from WebSocket on component on button click
  const disconnectWebSocket = useCallback(
    (
      options: {
        reason?: "failed" | "disconnected";
        shouldCloseSocket?: boolean;
      } = {},
    ) => {
      const { reason = "disconnected", shouldCloseSocket = true } = options;
      const activeSocket = wsRef.current;

      // Invalidate current attempt so stale socket callbacks are ignored.
      connectionAttemptRef.current += 1;

      wsRef.current = null;
      setWs(null);
      setPayload("");
      setLoadingConnection(false);

      if (shouldCloseSocket && activeSocket) {
        activeSocket.onclose = null; // Prevent triggering onclose event callback again
        activeSocket.close();
      }

      setMessages((prev) => [
        ...prev,
        reason === "failed"
          ? { failedConnectionEvent: true }
          : { disconnectionEvent: true },
      ]);
    },
    [],
  );

  // connect to WebSocket on component on button click
  const connectWebSocket = useCallback(() => {
    if (loadingConnection) return;

    setLoadingConnection(true);

    const attemptId = connectionAttemptRef.current + 1;
    connectionAttemptRef.current = attemptId;

    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
      setWs(null);
    }

    const socket = new WebSocket(wsUrl);

    let hasOpened = false;

    socket.onopen = () => {
      if (connectionAttemptRef.current !== attemptId) {
        socket.close();
        return;
      }

      hasOpened = true;
      wsRef.current = socket;
      setWs(socket);
      setLoadingConnection(false);
      setMessages((prev) => [...prev, { connectionEvent: true }]);
      setPayload(`{
  "action": "customAction",
  "message": "Hello from the client!"
}`);
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      if (connectionAttemptRef.current !== attemptId) {
        return;
      }

      const data = JSON.parse(event.data);
      setMessages((prevMessages) => [...prevMessages, data]);
    };

    socket.onclose = () => {
      if (connectionAttemptRef.current !== attemptId) {
        return;
      }

      disconnectWebSocket({
        reason: hasOpened ? "disconnected" : "failed",
        shouldCloseSocket: false,
      });
    };
  }, [wsUrl, disconnectWebSocket, loadingConnection]);

  const buttonState = !mounted && initialConnectionURL !== ""
    ? "connect"
    : loadingConnection || !wsUrl || !URLisValid
      ? "unavailable"
      : !ws ? "connect" : "disconnect";

  return (
    <section className="flex min-h-0 min-w-0 flex-[1_1_0] flex-col gap-3 vp-760:min-h-130 vp-760:flex-none" aria-labelledby={`${id}-title`}>
      <header className="flex min-w-0 items-baseline gap-2">
        <h2 id={`${id}-title`} className="m-0 font-sans text-body font-semibold leading-[1.3]">{title}</h2>
        <span className="min-w-0 overflow-hidden text-caption text-graphite text-ellipsis whitespace-nowrap">{description}</span>
      </header>

      {/* WebSocket URL Input */}
      <div className="flex h-8 min-w-0 gap-3">
        {!ws ? (
          <input
            type="text"
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
            // When enter is pressed in the URL input, connect to the WebSocket.
            onKeyDown={(event) => {
              if (event.key === "Enter" && URLisValid) connectWebSocket();
            }}
            placeholder="ws://"
            aria-label={`${title} connection URL`}
            className={cx(connectionUrlClasses, "border-rule-strong text-ink transition-[border-color,background-color] duration-120 enabled:hover:not-focus:border-graphite disabled:opacity-55 disabled:cursor-not-allowed", loadingConnection && "animate-ws-pulse")}
            disabled={!!ws}
            spellCheck={false}
          />
        ) : (
          <div className={cx(connectionUrlClasses, "flex select-none items-center border-[color-mix(in_srgb,var(--accept)_45%,var(--rule))] text-accept")} title={wsUrl} aria-label={`${title} connected to`}>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{wsUrl}</span>
          </div>
        )}
        <button
          type="button"
          className={cx("h-full flex-none cursor-pointer rounded-md border px-5 py-0 font-sans text-caption font-semibold leading-none transition-[background-color,color] duration-75 ease-in", connectionButtonClasses[buttonState])}
          onClick={() => (!ws ? connectWebSocket() : disconnectWebSocket())}
          disabled={loadingConnection || !wsUrl || !URLisValid}
        >
          {!ws ? "Connect" : "Disconnect"}
        </button>
      </div>

      {/* Payload Input */}
      <label className="mt-0 mr-0 -mb-1 ml-1 text-label font-medium text-graphite" htmlFor={`${id}-payload`}>Send payload</label>
      <div className="relative min-h-24 flex-[1_1_0]">
        <textarea
          className="h-full min-h-8 w-full min-w-0 max-w-none resize-none rounded-md border border-rule-strong bg-sheet p-3 font-mono text-caption leading-[1.5] text-ink transition-[border-color,background-color] duration-120 placeholder:text-faint placeholder:opacity-100 enabled:hover:not-focus:border-graphite disabled:cursor-not-allowed disabled:opacity-55"
          id={`${id}-payload`}
          ref={textareaRef}
          value={loadingConnection || !ws ? "" : payload}
          onChange={(e) => {
            setPayload(e.target.value);
            const { scrollHeight, clientHeight } = textareaRef.current!;
            setHasScrollbar(scrollHeight > clientHeight);
          }}
          placeholder={
            !ws || loadingConnection
              ? "You must establish a websocket connection first..."
              : "Enter your JSON payload here..."
          }
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
          spellCheck={false}
          disabled={!ws || loadingConnection}
        />
        <div className="pointer-events-none absolute bottom-[6px] opacity-0 transition-[opacity,right] duration-[200ms,100ms] ease-out data-[visible=true]:pointer-events-auto data-[visible=true]:opacity-100 data-[visible=true]:duration-100 data-[visible=true]:ease-in" data-visible={validPayload} style={{ right: hasScrollbar ? "23px" : "10px" }}>
          <button type="button" className="inline-flex size-8 min-h-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent bg-transparent p-0 text-faint transition-[background-color,border-color,color] duration-120 enabled:hover:text-prod disabled:cursor-not-allowed disabled:opacity-45" onClick={handleIconClick} disabled={!validPayload} tabIndex={validPayload ? 0 : -1} aria-label={`Send payload to ${title}`} title="Send payload">
            <Send size={15} aria-hidden />
          </button>
        </div>
      </div>

      {/* Messages Display */}
      <p className="mt-0 mr-0 -mb-1 ml-1 text-label font-medium text-graphite" id={`${id}-messages`}>Messages</p>
      <div ref={messagesRef} className="flex min-h-[140px] flex-[2_1_0] flex-col gap-2 overflow-y-auto overscroll-contain rounded-lg border border-rule bg-sheet p-3 text-caption" role="log" aria-labelledby={`${id}-messages`}>
        <div hidden>
          {mounted && (
            <Suspense fallback={<></>}>
              <ReactJsonView src={{}} />
            </Suspense>
          )}
        </div>
        {messages.map((msg, index) => (
          <div key={index} className="min-w-0 wrap-anywhere">
            {isLifecycleMessage(msg) &&
            (msg.connectionEvent ||
              msg.disconnectionEvent ||
              msg.failedConnectionEvent) ? (
              <div className={cx("font-medium", msg.connectionEvent ? "text-accept" : "text-refuse")}>
                {msg.connectionEvent
                  ? "Connected to WebSocket"
                  : msg.disconnectionEvent
                    ? "Disconnected from WebSocket"
                    : "Failed to connect to WebSocket"}
              </div>
            ) : (
              <Suspense fallback={<></>}>
                <ReactJsonView
                  theme={dark ? "ocean" : "rjv-default"}
                  collapsed={0}
                  enableClipboard={false}
                  style={{ backgroundColor: "transparent" }}
                  src={normalizeMessageForJsonView(msg)}
                  name={null}
                />
              </Suspense>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
