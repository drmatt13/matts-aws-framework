import { useState, useEffect, useRef, useCallback } from "react";
import parseJson from "parse-json";

import { lazy, Suspense } from "react";

const ReactJsonView = lazy(() => import("@microlink/react-json-view"));

const isValidJson = (str: string): boolean => {
  try {
    parseJson(str);
    return true;
  } catch (e) {
    return false;
  }
};

function isValidURL(str: string) {
  try {
    new URL(str); // Throws if the URL is invalid
    return true;
  } catch (e) {
    return false;
  }
}

interface Props {
  initialConnectionURL: string;
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
    return value;
  }

  return { value };
};

const WebSocketTester = ({ initialConnectionURL }: Props) => {
  const [mounted, setMounted] = useState(false);
  const [wsUrl, setWsUrl] = useState(initialConnectionURL);
  const wsUrlInputRef = useRef<HTMLInputElement>(null);
  const [URLisValid, setURLisValid] = useState(false);
  const [payload, setPayload] = useState("");
  const [validPayload, setValidPayload] = useState(false);
  const [hasScrollbar, setHasScrollbar] = useState(false);

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

    socket.onmessage = (event: MessageEvent<any>) => {
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

  useEffect(() => {
    // when enter is pressed in wsUrl input, connect to WebSocket
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        if (URLisValid) {
          connectWebSocket();
        }
      }
    };
    wsUrlInputRef.current?.addEventListener("keydown", handleKeyDown);
    return () => {
      wsUrlInputRef.current?.removeEventListener("keydown", handleKeyDown);
    };
  }, [URLisValid, connectWebSocket]);

  return (
    <div className="h-full flex-1 min-w-0">
      <div className="h-full w-full flex flex-col gap-3 grow-0">
        {/* WebSocket URL Input */}
        <div className="h-9 w-full min-w-0 flex gap-3">
          <div className="flex min-w-0 flex-1">
            {!ws ? (
              <input
                type="text"
                value={wsUrl}
                ref={wsUrlInputRef}
                onChange={(e) => setWsUrl(e.target.value)}
                placeholder="ws://"
                className={`${
                  loadingConnection && "animate-pulse"
                } h-full min-w-0 flex-1 bg-white/10 p-3 text-sm text-white/70 outline-none rounded-md`}
                disabled={!!ws}
              />
            ) : (
              <div className="h-full min-w-0 w-full overflow-hidden bg-white/10 p-3 text-sm text-green-600 outline-none rounded-md pointer-events-none">
                <p className="-translate-y-1 select-none truncate">
                  {wsUrl}
                </p>
              </div>
            )}
          </div>
          <button
            className={`${
              !mounted && initialConnectionURL !== ""
                ? "bg-green-700 hover:bg-green-600"
                : loadingConnection || !wsUrl || !URLisValid
                  ? "bg-neutral-700 text-neutral-400 cursor-not-allowed"
                  : `${
                      !ws
                        ? "bg-green-700 hover:bg-green-600"
                        : "bg-red-700/90 hover:bg-red-600/90"
                    } cursor-pointer`
            }} rounded-md px-5 text-xs duration-75 hover:duration-100 ease-in hover:ease-out shrink-0`}
            onClick={() => (!ws ? connectWebSocket() : disconnectWebSocket())}
            disabled={loadingConnection || !wsUrl || !URLisValid}
          >
            {!ws ? "Connect" : "Disconnect"}
          </button>
        </div>

        {/* Payload Input */}
        <p className="ml-1.5 text-sm">Send Payload:</p>
        <div className="flex-1/4 h-full w-full bg-white/10 rounded-lg overflow-hidden scheme-dark relative">
          <textarea
            ref={textareaRef}
            value={loadingConnection || !ws ? "" : payload}
            onChange={(e) => {
              setPayload(e.target.value);
              const { scrollHeight, clientHeight } = textareaRef.current!;
              setHasScrollbar(scrollHeight > clientHeight);
            }}
            className="h-full w-full bg-transparent p-3 outline-none resize-none text-xs relative overflow-y-auto"
            placeholder={
              !ws || loadingConnection
                ? "You must establish a websocket connection first..."
                : "Enter your JSON payload here..."
            }
            data-gramm="false"
            data-gramm_editor="false"
            data-enable-grammarly="false"
            disabled={!ws || loadingConnection}
          />
          <div
            className={`absolute bottom-1.5 transition-all duration-100`}
            style={{ right: hasScrollbar ? "23px" : "10px" }}
          >
            <div
              className={`${
                validPayload
                  ? "opacity-100 duration-100 ease-in pointer-events-auto"
                  : "opacity-0 duration-200 ease-out pointer-events-none"
              } bottom-1.5 transition-all `}
            >
              <i
                onClick={handleIconClick}
                className="fa-solid fa-paper-plane text-white/30 transition-colors hover:text-blue-400 duration-75 hover:duration-100 ease-in hover:ease-out cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Messages Display */}
        <p className="ml-1.5 text-sm">Messages:</p>
        <div className="flex-1/2 h-full w-full bg-white/10 rounded-lg overflow-hidden scheme-dark">
          <div
            ref={messagesRef}
            className="h-full w-full overflow-y-auto p-3 flex flex-col gap-2"
          >
            <div className="absolute hidden pointer-events-none -z-50">
              {mounted && (
                <Suspense fallback={<></>}>
                  <ReactJsonView src={{}} />
                </Suspense>
              )}
            </div>
            {messages.map((msg, index) => (
              <div key={index} className="text-xs">
                {isLifecycleMessage(msg) &&
                (msg.connectionEvent ||
                  msg.disconnectionEvent ||
                  msg.failedConnectionEvent) ? (
                  <div
                    className={`
                    ${msg.connectionEvent ? "text-green-600" : "text-red-600"}
                  `}
                  >
                    {msg.connectionEvent
                      ? "Connected to WebSocket"
                      : msg.disconnectionEvent
                        ? "Disconnected from WebSocket"
                        : "Failed to connect to WebSocket"}
                  </div>
                ) : (
                  <Suspense fallback={<></>}>
                    <ReactJsonView
                      theme={"ocean"}
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
        </div>
      </div>
    </div>
  );
};

export default WebSocketTester;
