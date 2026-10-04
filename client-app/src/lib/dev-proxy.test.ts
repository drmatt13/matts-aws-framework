import { describe, expect, it } from "vitest";
import { developmentApiProxy } from "../../dev-proxy";

describe("agent and HTTP dev proxy boundaries", () => {
  it("matches exact agent paths including queries, ahead of the general API proxy", () => {
    const proxy = developmentApiProxy("http://localhost:8080", { support: "/chat/support", review: "/api/review", special: "/chat/v1.0" });
    const keys = Object.keys(proxy);
    const match = (path: string) => keys.find((key) => new RegExp(key).test(path));
    expect(match("/chat/support")).toBe(keys[0]);
    expect(match("/chat/support?turn=2")).toBe(keys[0]);
    expect(match("/chat/support/extra")).toBeUndefined();
    expect(match("/Chat/support")).toBeUndefined();
    expect(match("/api/review?turn=2")).toBe(keys[1]);
    expect(match("/api/review/extra")).toBe(keys[3]);
    expect(match("/chat/v1X0")).toBeUndefined();
    expect(match("/chat/v1.0")).toBe(keys[2]);
    expect(match("/api/graphql")).toBe(keys[3]);
    expect(match("/apifoo")).toBeUndefined();
    expect(proxy[keys[0]]).not.toHaveProperty("rewrite");
    expect(proxy[keys[3]]).not.toHaveProperty("rewrite");
  });
});
