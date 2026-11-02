import type {
  AwsConnectionObservation,
  AwsProfileCatalog,
  AwsProfileKind,
} from "../../../shared/aws-connections";
import { NOW } from "./scenarios";

export function connectionCatalogFixture(
  profiles: readonly { name: string; kind?: string; region?: string }[] = [
    { name: "dev", kind: "sso", region: "us-east-1" },
    { name: "production", kind: "sso", region: "eu-west-1" },
  ],
): AwsProfileCatalog & { capabilities: object } {
  return {
    revision: "fixture-config-revision",
    profiles: profiles.map((profile) => ({
      name: profile.name,
      kind: (profile.kind ?? "unknown") as AwsProfileKind,
      mechanisms: [(profile.kind ?? "unknown") as AwsProfileKind],
      region: profile.region,
      hasMfa: false,
      editable: true,
      configuration: { region: profile.region },
      provenance: { config: true, credentials: false },
      diagnostics: [],
      ...(profile.kind === "sso" ? { ssoSession: "team-session" } : {}),
    })),
    sessions: [
      {
        name: "team-session",
        startUrl: "https://team.awsapps.com/start",
        region: "us-east-1",
        profiles: profiles
          .filter((profile) => profile.kind === "sso")
          .map((profile) => profile.name),
      },
    ],
    diagnostics: [],
    environment: { credentialsPresent: false, endpointOverridesPresent: false },
    capabilities: {
      available: true,
      version: "2.34.54",
      credentialExport: true,
      modernSso: true,
      pkce: true,
      consoleLogin: true,
    },
  };
}
export function connectionObservationFixture(
  profile: string,
  overrides: Partial<AwsConnectionObservation> = {},
): AwsConnectionObservation {
  return {
    profile,
    revision: "fixture-config-revision",
    state: "connected",
    checkedAt: NOW,
    region: { value: profile === "production" ? "eu-west-1" : "us-east-1", source: "profile" },
    identity: {
      account: "123456789012",
      arn: "arn:aws:sts::123456789012:assumed-role/Developer/tester",
      principalKind: "assumed-role",
      summary: "Developer / tester",
    },
    ...overrides,
  };
}
