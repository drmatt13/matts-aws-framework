import assert from "node:assert/strict";
import test from "node:test";
import { readNetworkDraft } from "../shared/networks";

const settings = { cidr: "10.2.0.0/16", zones: 2, nat: false, ipv6: true, s3: true, dynamodb: true, endpoints: [] };
test("network HTTP drafts accept VPC identities and validated settings", () => {
  const placement = { kind: "placement", target: "lambda:orders", vpc: "analytics", subnet: "private" };
  assert.deepEqual(readNetworkDraft(placement), placement);
  assert.deepEqual(readNetworkDraft({ kind: "placement", target: "lambda:orders", vpc: null, subnet: "none" }), { kind: "placement", target: "lambda:orders", vpc: null, subnet: "none" });
  assert.deepEqual(readNetworkDraft({ kind: "network", network: "analytics", settings }), { kind: "network", network: "analytics", settings });
});
test("network HTTP drafts reject paths, source expressions and identity changes", () => {
  for (const value of [
    { kind: "placement", target: "lambda:orders", vpc: "../elsewhere", subnet: "private" },
    { kind: "placement", target: "workflow:orders", vpc: "analytics", subnet: "private" },
    { kind: "placement", target: "lambda:orders", vpc: "analytics", subnet: "private", expression: "run()" },
    { kind: "network", network: "analytics", settings: { ...settings, id: "other" } },
    { kind: "network", network: "analytics", settings: { ...settings, zones: 1 } },
  ]) assert.throws(() => readNetworkDraft(value));
});
