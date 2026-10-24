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
    <section className="ws-tester" aria-labelledby={`${id}-title`}>
      <header className="ws-tester-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        <span>{description}</span>
      </header>

      {/* WebSocket URL Input */}
      <div className="ws-tester-connection">
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
            className={`ws-tester-url ${loadingConnection ? "connecting" : ""}`}
            disabled={!!ws}
            spellCheck={false}
          />
        ) : (
          <div className="ws-tester-url connected" title={wsUrl} aria-label={`${title} connected to`}>
            <span>{wsUrl}</span>
          </div>
        )}
        <button
          type="button"
          className={`ws-tester-connect ${buttonState}`}
          onClick={() => (!ws ? connectWebSocket() : disconnectWebSocket())}
          disabled={loadingConnection || !wsUrl || !URLisValid}
        >
          {!ws ? "Connect" : "Disconnect"}
        </button>
      </div>

      {/* Payload Input */}
      <label className="ws-tester-label" htmlFor={`${id}-payload`}>Send payload</label>
      <div className="ws-tester-payload">
        <textarea
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
        <div className="ws-tester-send" data-visible={validPayload} style={{ right: hasScrollbar ? "23px" : "10px" }}>
          <button type="button" className="icon-button" onClick={handleIconClick} disabled={!validPayload} tabIndex={validPayload ? 0 : -1} aria-label={`Send payload to ${title}`} title="Send payload">
            <Send size={15} aria-hidden />
          </button>
        </div>
      </div>

      {/* Messages Display */}
      <p className="ws-tester-label" id={`${id}-messages`}>Messages</p>
      <div ref={messagesRef} className="ws-tester-messages" role="log" aria-labelledby={`${id}-messages`}>
        <div hidden>
          {mounted && (
            <Suspense fallback={<></>}>
              <ReactJsonView src={{}} />
            </Suspense>
          )}
        </div>
        {messages.map((msg, index) => (
          <div key={index} className="ws-tester-message">
            {isLifecycleMessage(msg) &&
            (msg.connectionEvent ||
              msg.disconnectionEvent ||
              msg.failedConnectionEvent) ? (
              <div className={`ws-tester-event ${msg.connectionEvent ? "opened" : "closed"}`}>
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
