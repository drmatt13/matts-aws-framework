import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import { initializeAuthLifecycle } from "#/lib/auth";

import "./styles.css";

// Arms proactive token renewal and cross-tab sync before the first render,
// so a reload with a live refresh cookie restores the session silently.
initializeAuthLifecycle();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={getRouter()} />
  </StrictMode>,
);
