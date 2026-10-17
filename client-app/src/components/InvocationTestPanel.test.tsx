// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { frameworkHttpApiFetch } from "#/lib/auth";
import InvocationTestPanel from "./InvocationTestPanel";

vi.mock("#/lib/auth", () => ({ frameworkHttpApiFetch: vi.fn() }));
beforeEach(() => vi.mocked(frameworkHttpApiFetch).mockReset());
afterEach(cleanup);

it("submits the task through its authenticated starter and reports acceptance", async () => {
  vi.mocked(frameworkHttpApiFetch).mockResolvedValue(new Response(JSON.stringify({ runId: "run-1", taskId: "task-1" }), { status: 202 }));
  render(<InvocationTestPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Run test task" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Task submitted."));
  expect(frameworkHttpApiFetch).toHaveBeenCalledOnce();
  expect(frameworkHttpApiFetch).toHaveBeenCalledWith("/test/run-task", expect.objectContaining({
    method: "POST", body: JSON.stringify({ message: "Hello from the client app!" }),
  }));
});

it("shows a refused submission and enables retry", async () => {
  vi.mocked(frameworkHttpApiFetch).mockResolvedValue(new Response(JSON.stringify({ error: "Task could not be launched." }), { status: 502 }));
  render(<InvocationTestPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Run test task" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Task could not be launched."));
  expect((screen.getByRole("button", { name: "Run test task" }) as HTMLButtonElement).disabled).toBe(false);
});
