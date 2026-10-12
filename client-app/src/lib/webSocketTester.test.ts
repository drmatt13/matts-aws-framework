import { expect, test } from "vitest";

import { webSocketTesterUrl } from "./webSocketTester";

test("names both endpoints in the query and keeps the token in the fragment", () => {
  const link = new URL(webSocketTesterUrl(
    "http://localhost:3001",
    { local: "ws://localhost:8081", apiGateway: "wss://abc.execute-api.us-east-1.amazonaws.com/prod" },
    "header.payload.signature",
  ));

  expect(link.origin).toBe("http://localhost:3001");
  expect(link.searchParams.get("localWsUrl")).toBe("ws://localhost:8081");
  expect(link.searchParams.get("apiGatewayWsUrl")).toBe("wss://abc.execute-api.us-east-1.amazonaws.com/prod");
  expect(link.searchParams.has("token")).toBe(false);
  expect(new URLSearchParams(link.hash.slice(1)).get("token")).toBe("header.payload.signature");
});

test("leaves out an endpoint this build has none for, and the fragment without a token", () => {
  const link = new URL(webSocketTesterUrl("http://localhost:3001", { local: "ws://localhost:8081", apiGateway: " " }));

  expect([...link.searchParams.keys()]).toEqual(["localWsUrl"]);
  expect(link.hash).toBe("");
  expect(webSocketTesterUrl("http://localhost:3001/", {})).toBe("http://localhost:3001/");
});
