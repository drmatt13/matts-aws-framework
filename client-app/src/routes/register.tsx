import { useState } from "react";
import type { SubmitEvent } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import Button from "#/components/Button";
import LoginLayout from "#/components/layouts/LoginLayout";

import { redirectIfAuthenticated, signUpUser } from "#/lib/auth";

const MIN_NAME_LENGTH = 2;
// The user pool's rule (cdk-app/lib/app/cognito-stack.ts): length, not
// character classes.
const PASSWORD_POLICY_REGEX = /^.{12,}$/u;
const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 12 characters.";

export const Route = createFileRoute("/register")({
  beforeLoad: redirectIfAuthenticated,
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    const trimmedFirstName = firstName.trim();
    const trimmedLastName = lastName.trim();

    if (!trimmedFirstName || !trimmedLastName) {
      setStatus("First and last name are required.");
      return;
    }

    if (
      trimmedFirstName.length < MIN_NAME_LENGTH ||
      trimmedLastName.length < MIN_NAME_LENGTH
    ) {
      setStatus(
        `First and last name must be at least ${MIN_NAME_LENGTH} characters.`,
      );
      return;
    }

    if (password !== confirmPassword) {
      setStatus("Passwords do not match.");
      return;
    }

    if (!PASSWORD_POLICY_REGEX.test(password)) {
      setStatus(PASSWORD_POLICY_MESSAGE);
      return;
    }

    setStatus(null);
    setIsSubmitting(true);
    try {
      await signUpUser(
        email.trim(),
        password,
        trimmedFirstName,
        trimmedLastName,
      );
      await navigate({
        to: "/verify-account",
        search: {
          email: email.trim(),
          username: email.trim().toLowerCase(),
          code: "",
        },
      });
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Failed to create account.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <LoginLayout
      title="Create your account"
      subtitle="Get started with your workspace"
      footer={
        <>
          Already have an account?{" "}
          <Link
            to="/login"
            search={{ email: undefined, "account-verified": undefined }}
            disabled={isSubmitting}
            className={isSubmitting ? "text-muted/60 pointer-events-none" : "link"}
          >
            Sign in
          </Link>
        </>
      }
    >
      <form
        id="register-form"
        onSubmit={handleSubmit}
        className="mt-6 space-y-4"
      >
        {status && <p className="alert alert-bad">{status}</p>}

        {/* Names pair up once there is room for them, which keeps the form
            short enough to read without scrolling on a laptop. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="register-first-name" className="label">
              First name
            </label>
            <input
              type="text"
              id="register-first-name"
              autoComplete="given-name"
              required
              minLength={MIN_NAME_LENGTH}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              disabled={isSubmitting}
              className="field"
              placeholder="Jane"
            />
          </div>
          <div>
            <label htmlFor="register-last-name" className="label">
              Last name
            </label>
            <input
              type="text"
              id="register-last-name"
              autoComplete="family-name"
              required
              minLength={MIN_NAME_LENGTH}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              disabled={isSubmitting}
              className="field"
              placeholder="Doe"
            />
          </div>
        </div>

        <div>
          <label htmlFor="register-email" className="label">
            Email
          </label>
          <input
            type="email"
            id="register-email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isSubmitting}
            className="field"
            placeholder="name@firm.com"
          />
        </div>

        <div>
          <label htmlFor="register-password" className="label">
            Password
          </label>
          <input
            type="password"
            id="register-password"
            autoComplete="new-password"
            required
            minLength={12}
            title={PASSWORD_POLICY_MESSAGE}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isSubmitting}
            className="field"
            placeholder="••••••••"
          />
          <p className="mt-1.5 text-xs text-muted">
            At least 8 characters, with an uppercase, a lowercase and a number.
          </p>
        </div>

        <div>
          <label htmlFor="register-confirm-password" className="label">
            Confirm password
          </label>
          <input
            type="password"
            id="register-confirm-password"
            autoComplete="new-password"
            required
            minLength={12}
            title={PASSWORD_POLICY_MESSAGE}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={isSubmitting}
            className="field"
            placeholder="••••••••"
          />
        </div>

        <Button
          submit={true}
          fullWidth={true}
          text={isSubmitting ? "Creating account..." : "Create account"}
          style="primary"
          disabled={isSubmitting}
        />
      </form>
    </LoginLayout>
  );
}
