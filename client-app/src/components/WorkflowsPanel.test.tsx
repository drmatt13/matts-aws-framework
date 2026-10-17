// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { frameworkHttpApiFetch } from "#/lib/auth";
import WorkflowsPanel from "./WorkflowsPanel";

vi.mock("#/lib/auth", () => ({ frameworkHttpApiFetch: vi.fn() }));
beforeEach(() => vi.mocked(frameworkHttpApiFetch).mockReset());
afterEach(cleanup);

it("starts the declared workflow through the authenticated HTTP client", async () => {
  vi.mocked(frameworkHttpApiFetch).mockResolvedValue(new Response(JSON.stringify({ executionId: "execution-1" }), { status: 202 }));
  render(<WorkflowsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Workflow started."));
  expect(frameworkHttpApiFetch).toHaveBeenCalledOnce();
  expect(frameworkHttpApiFetch).toHaveBeenCalledWith("/test/start-workflow", expect.objectContaining({
    method: "POST", body: JSON.stringify({ message: "Hello from the client app!" }),
  }));
});

it("shows a refused starter response and allows another attempt", async () => {
  vi.mocked(frameworkHttpApiFetch).mockResolvedValue(new Response(JSON.stringify({ error: "Workflow is unavailable." }), { status: 502 }));
  render(<WorkflowsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Workflow is unavailable."));
  expect((screen.getByRole("button", { name: "Start workflow" }) as HTMLButtonElement).disabled).toBe(false);
});
