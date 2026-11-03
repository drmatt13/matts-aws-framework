/** A new deployment stage: declared under framework:targets and deployed as `<app>-<stage>`. */
export interface DeploymentStageRequest {
  readonly stage: string;
  readonly mode: "dev" | "prod";
  /** Required for production, so no other account can be deployed to by mistake. */
  readonly account?: string;
  readonly region?: string;
}
export interface DeploymentStageReview {
  readonly id: string;
  readonly stage: string;
  readonly mode: "dev" | "prod";
  /** The deployment the stage will be: `<app>-<stage>`. */
  readonly name: string;
  readonly changes: readonly { readonly file: string; readonly before: string; readonly after: string }[];
  readonly warnings: readonly string[];
}
