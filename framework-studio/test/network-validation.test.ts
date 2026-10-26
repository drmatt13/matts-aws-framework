import assert from "./support/assert";
import test from "node:test";
import { creationDefaults, networkCreationProblem, readCreationRequest } from "../shared/creation";
import { unusedNetworkCidr } from "../shared/networks";

const request = (extra: Record<string, unknown> = {}) => {
  const result = readCreationRequest({ kind: "vpc", ...creationDefaults("vpc"), id: "analytics", cidr: "10.1.0.0/16", ...extra });
  assert.equal(result.kind, "vpc");
  if (result.kind !== "vpc") throw new Error("Expected VPC");
  return result;
};
const networks = [{ id: "application", constructId: "NetworkStack", cidr: "10.0.0.0/16" }];

test("VPC creation validates stable identities, private ranges and names before review", () => {
  assert.equal(networkCreationProblem(request({ name: "Analytics workspace", nat: true }), networks), undefined);
  assert.match(networkCreationProblem(request({ id: "application" }), networks)!.message, /already exists/);
  assert.match(networkCreationProblem(request({ cidr: "10.0.0.0/16" }), networks)!.message, /overlaps VPC "application"/);
  assert.match(networkCreationProblem(request({ cidr: "10.000.0.0/16" }), networks)!.message, /overlaps VPC "application"/);
  assert.equal(networkCreationProblem(request({ id: "application", cidr: "10.0.0.0/16" }), networks, true), undefined);
  assert.match(networkCreationProblem(request(), [{ ...networks[0]!, constructId: "AnalyticsNetworkStack" }])!.message, /deployed construct identity/);
  for (const cidr of ["10.256.0.0/16", "10.1.2.0/16", "8.0.0.0/16", "10.1.0.0/24"]) assert.throws(() => request({ cidr }), /private \/16/);
  for (const name of [" ", "x".repeat(101)]) assert.throws(() => request({ name }), /display name/);
});

test("VPC suggestions use every supported private range before reporting exhaustion", () => {
  assert.equal(unusedNetworkCidr(networks), "10.1.0.0/16");
  assert.equal(unusedNetworkCidr([{ cidr: "10.000.0.0/16" }]), "10.1.0.0/16");
  const ten = Array.from({ length: 256 }, (_, octet) => ({ cidr: `10.${octet}.0.0/16` }));
  assert.equal(unusedNetworkCidr(ten), "172.16.0.0/16");
  const all = [...ten, ...Array.from({ length: 16 }, (_, octet) => ({ cidr: `172.${octet + 16}.0.0/16` }))];
  assert.equal(unusedNetworkCidr(all), "192.168.0.0/16");
  assert.equal(unusedNetworkCidr([...all, { cidr: "192.168.0.0/16" }]), undefined);
});
