// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { LAUNCH_URL_PARAMS, connectionUrlWithToken, consumeLaunchToken, launchConnectionUrl } from "./tokenHandoff";

afterEach(() => window.history.replaceState(null, "", "/"));

test("takes the launch token from the fragment and clears it from the address bar", () => {
  window.history.replaceState(null, "", "/?mode=local#token=header.payload.signature");

  expect(consumeLaunchToken()).toBe("header.payload.signature");
  expect(window.location.pathname + window.location.search + window.location.hash).toBe("/?mode=local");
});

test("prefills each panel from its launch parameter, keeping them after the token is cleared", () => {
  const search = new URLSearchParams({
    [LAUNCH_URL_PARAMS.local]: "ws://localhost:9081",
    [LAUNCH_URL_PARAMS.apiGateway]: "wss://abc.execute-api.us-east-1.amazonaws.com/prod",
  });
  window.history.replaceState(null, "", `/?${search}#token=header.payload.signature`);
  consumeLaunchToken();

  expect(launchConnectionUrl(LAUNCH_URL_PARAMS.local, "ws://localhost:8081?token=")).toBe("ws://localhost:9081");
  expect(launchConnectionUrl(LAUNCH_URL_PARAMS.apiGateway, "")).toBe("wss://abc.execute-api.us-east-1.amazonaws.com/prod");
});

test("falls back to the Compose setting when the launch link names no usable URL", () => {
  window.history.replaceState(null, "", `/?${LAUNCH_URL_PARAMS.apiGateway}=https%3A%2F%2Fexample.com`);

  expect(launchConnectionUrl(LAUNCH_URL_PARAMS.local, "ws://localhost:8081?token=")).toBe("ws://localhost:8081?token=");
  expect(launchConnectionUrl(LAUNCH_URL_PARAMS.apiGateway, "wss://fallback.example/prod")).toBe("wss://fallback.example/prod");
  expect(launchConnectionUrl(LAUNCH_URL_PARAMS.apiGateway, undefined)).toBe("");
  window.history.replaceState(null, "", `/?${LAUNCH_URL_PARAMS.local}=not%20a%20url`);
  expect(launchConnectionUrl(LAUNCH_URL_PARAMS.local, "")).toBe("");
});

test("fills the WebSocket token query without discarding other parameters", () => {
  expect(connectionUrlWithToken("ws://localhost:8081/?mode=local&token=", "header.payload.signature"))
    .toBe("ws://localhost:8081/?mode=local&token=header.payload.signature");
});
