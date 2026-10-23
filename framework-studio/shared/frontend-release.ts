/** Repository-owned, browser-public frontend build/publication settings. No credentials. */
export interface FrontendReleaseSettings {
  readonly projectDirectory: string;
  readonly buildScript: string;
  readonly buildArgs: readonly string[];
  readonly outputDirectory: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly prefix: string;
  readonly deleteRemote: boolean;
  readonly invalidationPaths: readonly string[];
}
export const FRONTEND_RELEASE_FILE = "framework-config/frontend-release.json";
export const DEFAULT_FRONTEND_RELEASE: FrontendReleaseSettings = {
  projectDirectory: "client-app", buildScript: "build", buildArgs: [], outputDirectory: "dist",
  include: ["**/*"], exclude: ["**/.env*", "**/*.map"], prefix: "", deleteRemote: false, invalidationPaths: ["/*"],
};
export interface FrontendDestination {
  readonly deployment: string;
  readonly mode: "dev" | "prod";
  readonly profile: string;
  readonly account: string;
  readonly region: string;
  readonly bucket: string;
  readonly distribution: string;
  readonly url: string;
}
export interface FrontendManifestEntry { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface FrontendReleaseReview {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly destination: FrontendDestination;
  readonly settings: FrontendReleaseSettings;
  readonly environmentFile: string;
  readonly files: readonly FrontendManifestEntry[];
  readonly deleteKeys: readonly string[];
  readonly commands: readonly string[];
  readonly warnings: readonly string[];
}
export interface FrontendReleaseResult {
  readonly id: string;
  readonly phase: "reviewed" | "uploading" | "uploaded" | "deleting" | "invalidating" | "complete" | "failed";
  readonly uploaded: readonly string[];
  readonly deleted: readonly string[];
  readonly invalidationId?: string;
  readonly invalidationStatus?: string;
  readonly httpStatus?: number;
  readonly message: string;
}
export interface FrontendSettingsReview {
  readonly id: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
}
