export interface DeploymentIdentityRequest {
  readonly mode: "dev" | "prod";
  readonly name: string;
  readonly account: string;
  readonly region: string;
}
export interface DeploymentIdentityReview {
  readonly id: string;
  readonly mode: "dev" | "prod";
  readonly name: string;
  readonly changes: readonly { readonly file: string; readonly before: string; readonly after: string }[];
  readonly warnings: readonly string[];
}
