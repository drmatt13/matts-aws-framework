// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { retryAuthSession } from "#/lib/auth";
import logout from "#/lib/logout";
import SessionError from "./SessionError";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("#/lib/logout", () => ({ default: vi.fn() }));
vi.mock("#/lib/auth", () => ({
  prepareForReauthentication: vi.fn(),
  retryAuthSession: vi.fn(),
}));

beforeEach(() => {
  navigate.mockReset().mockResolvedValue(undefined);
  vi.mocked(logout).mockReset().mockResolvedValue(undefined);
  vi.mocked(retryAuthSession).mockReset();
});

afterEach(cleanup);

it("an account that will not load can be signed out of", async () => {
  render(<SessionError kind="account" onRetry={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: "/login",
      replace: true,
      search: { email: undefined, "account-verified": undefined },
    }),
  );
  expect(logout).toHaveBeenCalledOnce();
  expect(vi.mocked(logout).mock.invocationCallOrder[0]).toBeLessThan(
    navigate.mock.invocationCallOrder[0],
  );
});

it("retrying an account load reloads the user without refreshing the session", async () => {
  const onRetry = vi.fn().mockResolvedValue(undefined);
  render(<SessionError kind="account" onRetry={onRetry} />);

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  expect(retryAuthSession).not.toHaveBeenCalled();
  expect(logout).not.toHaveBeenCalled();
});

it("an unavailable session still retries through a session refresh", async () => {
  vi.mocked(retryAuthSession).mockResolvedValue("refreshed");
  const onRetry = vi.fn();
  render(<SessionError kind="unavailable" onRetry={onRetry} />);

  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  expect(retryAuthSession).toHaveBeenCalledOnce();
});
