export interface SourceRecovery {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly fingerprint: string;
  readonly files: readonly { readonly file: string; readonly state: "original" | "written" | "conflicted" }[];
}
