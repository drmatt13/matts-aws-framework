import { useEffect, useState } from "react";
import {
  API_ROUTE,
  MfaResponseSchema,
  type MfaRequest,
  type MfaResponse,
} from "@repo/api-contract";

import Button from "#/components/Button";
import { frameworkHttpApiFetch } from "#/lib/auth";

/**
 * Two-step verification with an authenticator app.
 *
 * Status first; then a secret to add to the app; then the first code from the
 * app, which is what turns it on. Once on, every password sign-in asks for a
 * code — the login page already handles that challenge.
 *
 * Owns its own failure state, like the other panels on this page.
 */
async function callMfa(request: MfaRequest): Promise<MfaResponse> {
  const response = await frameworkHttpApiFetch(API_ROUTE["/mfa"], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = MfaResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!response.ok || !body.success) {
    throw new Error(
      body.success && body.data.error
        ? body.data.error
        : `Request failed with status ${response.status}.`,
    );
  }
  return body.data;
}

type Step =
  | { readonly kind: "loading" }
  | { readonly kind: "off" }
  | { readonly kind: "enrolling"; readonly secretCode: string; readonly otpauthUri: string }
  | { readonly kind: "on" };

/** The secret in groups of four, which is how people type it into an app. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export default function SecurityPanel() {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    callMfa({ action: "status" })
      .then((status) => {
        if (!cancelled) setStep({ kind: status.totpEnabled ? "on" : "off" });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setStep({ kind: "off" });
        setError(reason instanceof Error ? reason.message : "Couldn't read your security settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const startSetup = () =>
    run(async () => {
      const result = await callMfa({ action: "setup" });
      if (!result.secretCode || !result.otpauthUri) {
        throw new Error("No secret was issued. Try again.");
      }
      setCode("");
      setStep({ kind: "enrolling", secretCode: result.secretCode, otpauthUri: result.otpauthUri });
    });

  const verify = () =>
    run(async () => {
      const result = await callMfa({ action: "verify", code: code.trim() });
      if (result.totpEnabled) setStep({ kind: "on" });
    });

  return (
    <section className="card mt-4">
      <h2 className="text-sm font-semibold">Two-step verification</h2>

      {step.kind === "loading" && (
        <p className="mt-1.5 text-sm text-muted">Checking your settings…</p>
      )}

      {step.kind === "on" && (
        <p className="mt-1.5 text-sm text-muted">
          On. Signing in with your password also asks for a code from your
          authenticator app.
        </p>
      )}

      {step.kind === "off" && (
        <>
          <p className="mt-1.5 text-sm text-muted">
            Add a code from an authenticator app to every password sign-in.
          </p>
          <div className="mt-4">
            <Button
              text={busy ? "Preparing..." : "Set up an authenticator app"}
              onClick={startSetup}
              disabled={busy}
            />
          </div>
        </>
      )}

      {step.kind === "enrolling" && (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <p className="text-sm text-muted">
            Add this key to your authenticator app, or{" "}
            <a className="link" href={step.otpauthUri}>
              open it in the app
            </a>{" "}
            on this device. Then enter the 6-digit code it shows.
          </p>
          <p className="w-max max-w-full rounded-lg bg-ink/5 px-3 py-2 font-mono text-sm break-all">
            {groupSecret(step.secretCode)}
          </p>
          <label htmlFor="mfa-code" className="label">
            Code from your app
          </label>
          <input
            id="mfa-code"
            className="field"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <Button
            text={busy ? "Checking..." : "Turn on"}
            submit
            disabled={busy || code.trim().length !== 6}
          />
        </form>
      )}

      {error && (
        <p role="alert" className="alert alert-bad mt-4">
          {error}
        </p>
      )}
    </section>
  );
}
