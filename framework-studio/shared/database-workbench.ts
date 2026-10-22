import type { DeclaredSchema } from "./database";

/** Offsets are UTF-16 editor positions. All ranges refer to the exact sourceHash. */
export interface DatabaseDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "warning" | "info";
  readonly code: string;
  readonly message: string;
}

export interface DatabaseValidation {
  readonly sourceHash: string;
  readonly valid: boolean;
  readonly diagnostics: readonly DatabaseDiagnostic[];
  readonly schema?: DeclaredSchema;
  readonly storageHash?: string;
  readonly executionHash?: string;
  readonly validatedAt: string;
}

export interface DatabaseTarget {
  readonly id: "local:postgres" | "production";
  readonly label: string;
  readonly available: boolean;
  readonly detail: string;
  /** Hash of resolved private identity, never a connection string or credential. */
  readonly identity: string;
}

export interface DatabaseWorkbench {
  readonly file: string;
  readonly source: string;
  /** Content revision, independent from framework snapshot generations. */
  readonly revision: string;
  /** Opaque per-server identity of configuration, imported local modules and private inputs. */
  readonly configRevision: string;
  readonly validation: DatabaseValidation;
  readonly capabilities: {
    readonly dialect: string;
    readonly semanticValidation: boolean;
    readonly formatting: boolean;
    readonly languageServer: boolean;
    readonly notes: readonly string[];
  };
  readonly targets: readonly DatabaseTarget[];
  readonly emitted?: {
    readonly status: "matches" | "differs" | "missing" | "invalid" | "unknown";
    readonly file: string;
    readonly revision: string;
    readonly observedAt: string;
    readonly storageHash?: string;
    readonly executionHash?: string;
    readonly storageMatches?: boolean;
    readonly executionMatches?: boolean;
    readonly message: string;
  };
}

export interface DatabaseSourceReview {
  readonly reviewId: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly expectedRevision: string;
  readonly configRevision: string;
  readonly sourceHash: string;
  readonly expiresAt: string;
  readonly validation: DatabaseValidation;
  readonly effects: readonly string[];
}

export interface DatabaseSaveResult {
  readonly saved: true;
  readonly revision: string;
  readonly source: string;
  readonly file: string;
  /** Source success is reported independently from a graph-refresh failure. */
  readonly refresh: "complete" | "unavailable";
  readonly message: string;
}

export interface DatabaseObservation {
  readonly id: string;
  readonly targetId: DatabaseTarget["id"];
  readonly targetIdentity: string;
  readonly observedAt: string;
  readonly savedRevision: string;
  readonly historyRevision: string;
  readonly baseline: { readonly label: string; readonly storageHash?: string };
  readonly status: "observed" | "unreachable" | "unsupported" | "stale";
  readonly marker: { readonly status: "matches" | "differs" | "missing" | "unknown"; readonly storageHash?: string; readonly updatedAt?: string };
  readonly physical: { readonly status: "matches" | "differs" | "unknown"; readonly issues: readonly string[]; readonly warnings: readonly string[] };
  readonly historicalPhysical?: { readonly storageHash: string; readonly status: "matches" | "differs" | "unknown"; readonly issues: readonly string[]; readonly warnings: readonly string[] };
  readonly migrationState: { readonly status: "current" | "pending" | "divergent" | "unknown"; readonly message: string };
  readonly ledger: readonly { readonly migrationHash: string; readonly name: string; readonly from: string | null; readonly to: string; readonly appliedAt: string }[];
  readonly message: string;
  readonly limits: readonly string[];
}
