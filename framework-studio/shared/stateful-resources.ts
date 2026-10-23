import type { Mode } from "./model";
import type { DatabaseReference } from "../../cdk-app/lib/app/database-lifecycle";
import type { CognitoReference } from "../../cdk-app/lib/app/cognito-lifecycle";

export type StatefulKind = "database" | "cognito";
export type StatefulRetention = "retain" | "remove";
export interface StatefulResourceSource {
  readonly retention?: StatefulRetention;
  readonly reference?: DatabaseReference | CognitoReference;
}
export interface StatefulSource {
  readonly file: string;
  readonly hash: string;
  readonly mode: Mode;
  readonly resources: Readonly<Record<StatefulKind, StatefulResourceSource>>;
  readonly legacy: { readonly file: string; readonly retain: boolean; readonly configured: boolean };
  readonly problems: readonly string[];
}
export interface StatefulSelection {
  readonly profile: string;
  readonly deployment: string;
  readonly region: string;
  readonly mode: Mode;
}
export interface StatefulInspection {
  readonly kind: StatefulKind;
  readonly reference: DatabaseReference | CognitoReference;
  readonly observedAt?: string;
  readonly checks?: readonly string[];
  readonly warnings?: readonly string[];
  readonly evidence?: { readonly observedAt?: string; readonly checks?: readonly string[] };
}
export interface StatefulInventory {
  readonly account: string;
  readonly region: string;
  readonly ledgers: readonly {
    readonly deployment: string;
    readonly mode: Mode;
    readonly observations: readonly {
      readonly createdAt: string;
      readonly phase: string;
      readonly resources: readonly { readonly stack: string; readonly stackId: string; readonly logicalId: string; readonly type: string; readonly policy: string; readonly physicalId?: string }[];
    }[];
  }[];
}
export interface StatefulPlan {
  readonly planId: string;
  readonly expiresAt: string;
  readonly effects: readonly string[];
  readonly changes: readonly { readonly file: string; readonly diff: { readonly unified: string } }[];
  readonly inspection?: StatefulInspection;
}
