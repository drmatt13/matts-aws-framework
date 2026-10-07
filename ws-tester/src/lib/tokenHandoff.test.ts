// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { connectionUrlWithToken, consumeLaunchToken } from "./tokenHandoff";

afterEach(() => window.history.replaceState(null, "", "/"));

test("takes the launch token from the fragment and clears it from the address bar", () => {
  window.history.replaceState(null, "", "/?mode=local#token=header.payload.signature");

  expect(consumeLaunchToken()).toBe("header.payload.signature");
  expect(window.location.pathname + window.location.search + window.location.hash).toBe("/?mode=local");
});

test("fills the WebSocket token query without discarding other parameters", () => {
  expect(connectionUrlWithToken("ws://localhost:8081/?mode=local&token=", "header.payload.signature"))
    .toBe("ws://localhost:8081/?mode=local&token=header.payload.signature");
});
