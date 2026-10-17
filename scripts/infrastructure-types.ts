export const INFRASTRUCTURE_OWNER = "framework:infrastructure-owner:v1";
export interface InfrastructureOwner { entity: string; role: "primary" | "supporting"; external?: boolean; stack?: boolean }
export interface InfrastructureSource { file: string; line: number; column?: number }
export interface InfrastructureResource {
  id: string;
  stack: string;
  logicalId?: string;
  type: string;
  constructPath?: string;
  condition?: string;
  classification: "framework" | "supporting" | "imported" | "unowned";
  owners: string[];
  source?: InfrastructureSource;
}
export interface InfrastructureInventory {
  version: 1;
  stacks: { id: string; name: string; environment: string; dependencies: string[]; owners: string[] }[];
  resources: InfrastructureResource[];
  dependencies: { from: string; to: string; kind: "depends-on" | "reference" | "import" }[];
  notes: string[];
}

