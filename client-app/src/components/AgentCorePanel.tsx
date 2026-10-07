import { useId, useState } from "react";

import Button from "#/components/Button";
import { streamAgent } from "#/lib/agents";

export default function AgentCorePanel() {
  const fieldId = useId();
  const [conversationId] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("Hello from the client app!");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function invoke() {
    setRunning(true);
    setEvents([]);
    setError(null);

    try {
      for await (const event of streamAgent(
        "echo-agent",
        { message },
        { conversationId },
      )) {
        setEvents((current) => [...current, event]);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Agent request failed.",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="card mt-4">
      <h2 className="text-sm font-semibold">AgentCore</h2>
      <p className="mt-1.5 text-sm text-muted">
        Send a message to the declared echo agent and read its streamed events.
      </p>
      <label htmlFor={fieldId} className="label mt-4">
        Message
      </label>
      <textarea
        id={fieldId}
        className="field min-h-24"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        maxLength={2000}
        disabled={running}
      />
      <div className="mt-4">
        <Button
          text={running ? "Invoking..." : "Invoke AgentCore"}
          onClick={invoke}
          disabled={running || !message.trim()}
        />
      </div>
      {error && (
        <p role="alert" className="alert alert-bad mt-4">
          {error}
        </p>
      )}
      {events.length > 0 && (
        <pre
          role="status"
          className="mt-4 overflow-x-auto rounded-lg bg-ink/5 p-3 text-xs whitespace-pre-wrap break-words"
        >
          {JSON.stringify(events, null, 2)}
        </pre>
      )}
    </section>
  );
}
