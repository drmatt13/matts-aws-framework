import assert from "node:assert/strict";
import test from "node:test";
import { statefulTeardownConsequences } from "../../scripts/stateful-teardown";

/** Independent failure injection: reverse network associations are not edges
 * reachable by walking the retained DB's forward references alone. */
function retainedNetwork() {
  const resources: Record<string, any> = {
    Database: { Type: "AWS::RDS::DBInstance", Properties: { DBSubnetGroupName: { Ref: "DatabaseSubnets" } } },
    DatabaseSubnets: { Type: "AWS::RDS::DBSubnetGroup", Properties: { SubnetIds: [{ Ref: "Subnet" }] } },
    Subnet: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "Vpc" } } },
    Vpc: { Type: "AWS::EC2::VPC" },
    Table: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: { Ref: "Vpc" } } },
    Association: { Type: "AWS::EC2::SubnetRouteTableAssociation", Properties: { SubnetId: { Ref: "Subnet" }, RouteTableId: { Ref: "Table" } } },
    Route: { Type: "AWS::EC2::Route", Properties: { RouteTableId: { Ref: "Table" }, NatGatewayId: { Ref: "Nat" } } },
    Nat: { Type: "AWS::EC2::NatGateway", Properties: { SubnetId: { Ref: "Subnet" }, AllocationId: { "Fn::GetAtt": ["Address", "AllocationId"] } } },
    Address: { Type: "AWS::EC2::EIP" },
    Attachment: { Type: "AWS::EC2::VPCGatewayAttachment", Properties: { VpcId: { Ref: "Vpc" }, InternetGatewayId: { Ref: "Internet" } } },
    Internet: { Type: "AWS::EC2::InternetGateway" },
  };
  for (const resource of Object.values(resources)) resource.DeletionPolicy = "Retain";
  return resources;
}

test("independent teardown review refuses lost route, gateway and address behind retained reverse associations", () => {
  for (const lost of ["Table", "Association", "Route", "Nat", "Address", "Attachment", "Internet"]) {
    const resources = retainedNetwork();
    resources[lost].DeletionPolicy = "Delete";
    const result = statefulTeardownConsequences(new Map([["Infrastructure", { Resources: resources }]]));
    assert.ok(result.blockers.some(message => message.includes(`Infrastructure/${lost}`)), `Deletion of ${lost} must block before any stack deletion`);
  }
  assert.deepEqual(statefulTeardownConsequences(new Map([["Infrastructure", { Resources: retainedNetwork() }]])).blockers, []);
});

test("independent teardown review explains external reference consequences even when no database L1 exists", () => {
  const result = statefulTeardownConsequences(new Map([["Reuse", {
    Metadata: { "framework:stateful-reference": { kind: "database", reference: { instanceIdentifier: "original-postgres", network: { vpcId: "vpc-0123456789abcdef0" } } } },
    Resources: { Clients: { Type: "AWS::EC2::SecurityGroup", Properties: { VpcId: "vpc-0123456789abcdef0" } } },
  }]]));
  assert.equal(result.blockers.length, 0);
  assert.match(result.warnings.join(" "), /original-postgres/);
  assert.match(result.warnings.join(" "), /external|referenc/i);
});
