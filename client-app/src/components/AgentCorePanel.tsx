import { useId, useState } from "react";

import Button from "#/components/Button";
import { streamAgent } from "#/lib/agents";

interface Entry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export default function AgentCorePanel() {
  const fieldId = useId();
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("What is (2 + 3) * 4?");
  const [transcript, setTranscript] = useState<Entry[]>([]);
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const text = message.trim();
    // A pending interrupt is answered with resume, not with a new message.
    const input = pending
      ? ({ type: "resume", response: text } as const)
      : ({ type: "message", message: text } as const);
    setRunning(true);
    setError(null);
    setMessage("");
    setReply("");
    setTranscript((current) => [...current, { role: "user", text }]);

    let streamed = "";
    try {
      for await (const event of streamAgent("example-agent", input, { conversationId })) {
        if (event.type === "delta") {
          streamed += event.text;
          setReply(streamed);
        } else if (event.type === "message") {
          setPending(null);
          setReply("");
          setTranscript((current) => [...current, { role: "assistant", text: event.text }]);
        } else if (event.type === "interrupt") {
          setPending(event.prompt);
          setReply("");
          setTranscript((current) => [...current, { role: "assistant", text: event.prompt }]);
        } else if (event.type === "refused") {
          setPending(null);
          setError(event.message);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent request failed.");
    } finally {
      setReply("");
      setRunning(false);
    }
  }

  function restart() {
    setConversationId(crypto.randomUUID());
    setTranscript([]);
    setPending(null);
    setError(null);
  }

  return (
    <section className="card mt-4">
      <h2 className="text-sm font-semibold">AgentCore</h2>
      <p className="mt-1.5 text-sm text-muted">
        Chat with the example LangGraph agent. It does arithmetic through its
        Gateway tools and may pause to ask for your confirmation.
      </p>
      {(transcript.length > 0 || reply) && (
        <ol
          role="log"
          className="mt-4 space-y-2 rounded-lg bg-ink/5 p-3 text-sm whitespace-pre-wrap wrap-break-word"
        >
          {transcript.map((entry, index) => (
            <li key={index}>
              <span className="font-medium">
                {entry.role === "user" ? "You" : "Agent"}:
              </span>{" "}
              {entry.text}
            </li>
          ))}
          {reply && (
            <li>
              <span className="font-medium">Agent:</span> {reply}
            </li>
          )}
        </ol>
      )}
      {pending && (
        <p className="alert alert-info mt-4">
          The agent is waiting for your answer before it continues.
        </p>
      )}
      <label htmlFor={fieldId} className="label mt-4">
        {pending ? "Your answer" : "Message"}
      </label>
      <textarea
        id={fieldId}
        className="field min-h-24"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        maxLength={8000}
        disabled={running}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          text={running ? "Thinking..." : pending ? "Answer" : "Send"}
          onClick={send}
          disabled={running || !message.trim()}
        />
        <Button
          style="secondary"
          icon="reset"
          text="New conversation"
          onClick={restart}
          disabled={running || transcript.length === 0}
        />
      </div>
      {error && (
        <p role="alert" className="alert alert-bad mt-4">
          {error}
        </p>
      )}
    </section>
  );
}
