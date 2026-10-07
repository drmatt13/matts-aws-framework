import { useId, useState } from "react";

import Button from "#/components/Button";
import { frameworkHttpApiFetch } from "#/lib/auth";

interface JsonRequestPanelProps {
  title: string;
  description: string;
  path: string;
  initialPayload: string;
  buttonText: string;
}

export default function JsonRequestPanel({
  title,
  description,
  path,
  initialPayload,
  buttonText,
}: JsonRequestPanelProps) {
  const fieldId = useId();
  const [payload, setPayload] = useState(initialPayload);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setResult(null);
    setError(null);

    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Payload must be a JSON object.");
      }
      const response = await frameworkHttpApiFetch(
        new URL(`/api${path}`, window.location.origin),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed),
        },
      );
      const body = await response.text();
      let displayed = body;
      try {
        displayed = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // Plain text responses are shown as received.
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${displayed || response.statusText}`);
      }
      setResult(displayed || `HTTP ${response.status}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card mt-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1.5 text-sm text-muted">{description}</p>
      <label htmlFor={fieldId} className="label mt-4">
        JSON payload
      </label>
      <textarea
        id={fieldId}
        className="field min-h-28 font-mono"
        value={payload}
        onChange={(event) => setPayload(event.target.value)}
        spellCheck={false}
        disabled={submitting}
      />
      <div className="mt-4">
        <Button
          text={submitting ? "Sending..." : buttonText}
          onClick={submit}
          disabled={submitting}
        />
      </div>
      {error && <p role="alert" className="alert alert-bad mt-4">{error}</p>}
      {result && (
        <pre role="status" className="mt-4 overflow-x-auto rounded-lg bg-ink/5 p-3 text-xs whitespace-pre-wrap break-words">
          {result}
        </pre>
      )}
    </section>
  );
}
