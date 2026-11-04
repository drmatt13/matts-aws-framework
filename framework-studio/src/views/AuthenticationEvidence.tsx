import type { CognitoObservation, IdentityPoolsObservation, IdentitySource } from "../../shared/identity";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import {
  DocumentCard,
  documentDataTableClasses,
  documentTableRegionClasses,
  documentTitleClasses,
  documentProseClasses,
  documentSupportClasses,
  documentSummaryClasses,
  documentDisclosureClasses,
} from "./DocumentUI";

/** Read-only authentication evidence. The workspace owns requests, approvals and panel lifetime. */
export const evidenceFactsClasses =
  "m-0 grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-x-5 gap-y-3";
export const evidenceLabelClasses = "mb-1 text-caption font-normal text-graphite";
export const evidenceValueClasses = "m-0 text-label wrap-anywhere";

export function ProviderEvidence({
  source,
  result,
}: {
  readonly source?: IdentitySource;
  readonly result?: CognitoObservation;
}) {
  const { snapshot } = useStudio();
  const declared = source?.declaredProviders ?? [];
  const framework = source?.signInProviders ?? [];
  const rows = [
    // The framework's own providers: built where the inputs file sets all of a provider's lines.
    ...framework.map((provider) => {
      const unset = provider.lines.filter((line) => !line.present);
      const secret = provider.lines.find((line) => line.secret);
      return {
        name: provider.cognitoName,
        type: `${provider.title} · framework managed`,
        supported: true,
        declaration: !unset.length
          ? "All lines set; built at synthesis"
          : unset.length === provider.lines.length
            ? "Not configured"
            : `Partly set; synthesis stops until ${unset.map((line) => line.name).join(", ")} ${unset.length === 1 ? "is" : "are"} set`,
        secret: secret?.present
          ? "Authored input present; access unverified"
          : "Presence / access unverified",
      };
    }),
    ...declared.map((provider) => ({
      name: provider.name,
      type: provider.type.toUpperCase(),
      supported: true,
      declaration: `${provider.scope === "both" || provider.scope === source?.mode ? "Declared for this environment" : "Declared for another environment"} · ${provider.scope}`,
      secret:
        provider.type === "oidc" ? "Reference declared; access unverified" : "Not required by SAML",
    })),
    ...(result?.providers ?? [])
      .filter(
        (provider) =>
          !framework.some((entry) => entry.cognitoName === provider.name) &&
          !declared.some((entry) => entry.name === provider.name),
      )
      .map((provider) => ({
        name: provider.name,
        type: provider.type,
        supported: /^(OIDC|SAML)$/i.test(provider.type),
        declaration: "Not matched to a source declaration",
        secret: "Presence / access unverified",
      })),
  ];
  return (
    <DocumentCard className="mb-3">
      <h3 className={documentTitleClasses}>Federation providers</h3>
      <p className={documentSupportClasses}>
        The framework manages Google, Microsoft and Meta sign-in; Studio also supports declared
        OIDC and SAML providers. Source, AWS metadata and a working sign-in are separate checks.
      </p>
      {source ? (
        <div className="flex flex-col items-start gap-2 [&>p]:m-0 vp-720:items-stretch">
          <a
            className={buttonClasses({ variant: "quiet" })}
            href={editorLink(snapshot.repositoryRoot, {
              file: source.file,
              line: 1,
              column: 1,
              start: 0,
              end: 0,
            })}
          >
            Open sign-in provider inputs in editor
          </a>
          <p className={documentSupportClasses}>
            <code>{source.file}</code>
            {framework.flatMap((provider) => provider.lines).map((line) => (
              <span key={line.name}>
                {" · "}
                <code>{line.name}</code>: {line.present ? "present" : "absent"}
              </span>
            ))}
            . Values stay in your editor.
          </p>
        </div>
      ) : null}
      <div
        className="my-2 max-w-full overflow-auto"
        tabIndex={0}
        role="region"
        aria-label="Provider verification evidence"
      >
        <table className="table w-full min-w-[820px] border-collapse">
          <thead>
            <tr>
              <th className="border-b border-rule p-2 text-left align-top text-caption">
                Provider
              </th>
              <th className="border-b border-rule p-2 text-left align-top text-caption">
                Source intent
              </th>
              <th className="border-b border-rule p-2 text-left align-top text-caption">
                Deployed metadata
              </th>
              <th className="border-b border-rule p-2 text-left align-top text-caption">Secret</th>
              <th className="border-b border-rule p-2 text-left align-top text-caption">
                Provider application
              </th>
              <th className="border-b border-rule p-2 text-left align-top text-caption">Sign-in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <th
                  className="border-b border-rule p-2 text-left align-top text-caption"
                  scope="row"
                >
                  {row.name}
                  <small className="mt-1 block font-normal whitespace-nowrap text-graphite">
                    {row.type} ·{" "}
                    {row.supported ? "supported" : "native provider; source authoring unavailable"}
                  </small>
                </th>
                <td className="border-b border-rule p-2 text-left align-top text-caption">
                  {row.declaration}
                </td>
                <td className="border-b border-rule p-2 text-left align-top text-caption">
                  {result
                    ? result.providers.some((provider) => provider.name === row.name)
                      ? "Observed in selected pool"
                      : "Not returned by inspection"
                    : "Unverified"}
                </td>
                <td className="border-b border-rule p-2 text-left align-top text-caption">
                  {row.secret}
                </td>
                <td className="border-b border-rule p-2 text-left align-top text-caption">
                  Unverified
                </td>
                <td className="border-b border-rule p-2 text-left align-top text-caption">
                  Unverified
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result?.providers.map((provider) => (
        <details className={documentDisclosureClasses} key={provider.name}>
          <summary className={documentSummaryClasses}>
            {provider.name} · observed configuration
          </summary>
          <dl className={evidenceFactsClasses}>
            {Object.entries(provider.settings).map(([key, value]) => (
              <div key={key} className="min-w-0">
                <dt className={evidenceLabelClasses}>{key}</dt>
                <dd className={evidenceValueClasses}>{value}</dd>
              </div>
            ))}
          </dl>
          <p className={documentProseClasses}>
            Mapped attributes: {provider.mappedAttributes.join(", ") || "none returned"}
          </p>
        </details>
      ))}
      <details className={documentDisclosureClasses}>
        <summary className={documentSummaryClasses}>
          Provider setup and verification
        </summary>
        <p className={documentProseClasses}>
          For Google, review the{" "}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
          >
            OAuth client settings
          </a>
          , consent/test-user policy and{" "}
          <code>https://&lt;cognito-domain&gt;/oauth2/idpresponse</code> redirect. Start sign-in
          from the application to preserve PKCE/state.
        </p>
        <p className={documentProseClasses}>
          For Microsoft, the Entra app registration is single tenant, uses the same redirect and
          adds the <code>xms_edov</code> optional claim to its ID token; without it every
          Microsoft identity arrives unverified. For Meta, the Facebook Login app grants the{" "}
          <code>email</code> permission and lists the same redirect as a valid OAuth redirect URI.
        </p>
        <p className={documentProseClasses}>
          For{" "}
          <a
            href="https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html"
            target="_blank"
            rel="noreferrer"
          >
            OIDC
          </a>
          , verify issuer, discovery, scopes, redirect and verified-email claims. For{" "}
          <a
            href="https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html"
            target="_blank"
            rel="noreferrer"
          >
            SAML
          </a>
          , verify metadata, SP entity ID and ACS. The application callback is distinct from the
          provider callback.
        </p>
        <p className={documentProseClasses}>
          Secret values are never requested here. Authored presence does not establish a deployed
          value, accessible secret or accepted provider credentials.
        </p>
      </details>
    </DocumentCard>
  );
}

export function Groups({ result }: { readonly result?: CognitoObservation }) {
  return (
    <DocumentCard className="mb-3">
      <h3 className={documentTitleClasses}>Groups and role claims</h3>
      {result ? (
        <>
          <div
            className={documentTableRegionClasses}
            role="region"
            aria-label="Cognito groups"
            tabIndex={0}
          >
            <table className={documentDataTableClasses}>
              <colgroup>
                <col className="w-[180px]" />
                <col className="w-[120px]" />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th className="border-b border-rule p-2 text-left align-top text-caption">
                    Group
                  </th>
                  <th className="border-b border-rule p-2 text-left align-top text-caption">
                    Precedence
                  </th>
                  <th className="border-b border-rule p-2 text-left align-top text-caption">
                    IAM role claim
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.groups.map((group) => (
                  <tr key={group.name}>
                    <th
                      className="border-b border-rule p-2 text-left align-top text-caption"
                      scope="row"
                    >
                      {group.name}
                    </th>
                    <td className="border-b border-rule p-2 text-left align-top text-caption">
                      {group.precedence ?? "Unspecified"}
                    </td>
                    <td className="border-b border-rule p-2 text-left align-top text-caption">
                      {group.roleArn ?? "No IAM role"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.groups.length ? (
            <p className={documentProseClasses}>
              No groups returned for this pool.
            </p>
          ) : null}
        </>
      ) : (
        <p className={documentProseClasses}>
          Inspect authentication to read groups from the selected deployment-owned user pool.
        </p>
      )}
      <p className={documentSupportClasses}>
        Cognito groups influence token claims. Application RBAC, identity-pool role selection and
        IAM authorization are independent.
      </p>
    </DocumentCard>
  );
}

export function PoolRelationships({ result }: { readonly result?: IdentityPoolsObservation }) {
  return (
    <>
      {result?.pools.map((pool) => (
        <DocumentCard className="mb-3" key={pool.id}>
          <h3 className={documentTitleClasses}>{pool.name}</h3>
          <p className={documentProseClasses}>
            <code>{pool.id}</code>{" "}
            <span className="inline-block rounded-sm border border-rule bg-wash px-[6px] py-0.5 text-meta leading-[1.5]">
              AWS metadata observed
            </span>
          </p>
          <dl className={evidenceFactsClasses}>
            <div className="min-w-0">
              <dt className={evidenceLabelClasses}>Guest identities</dt>
              <dd className={evidenceValueClasses}>
                {pool.guests ? "Enabled — inspect unauthenticated role permissions" : "Disabled"}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className={evidenceLabelClasses}>User-pool providers</dt>
              <dd className={evidenceValueClasses}>
                {pool.providers.map((provider) => (
                  <div key={provider.clientId}>
                    {provider.name}
                    <br />
                    Client <code>{provider.clientId}</code>
                  </div>
                ))}
              </dd>
            </div>
          </dl>
          <details className={documentDisclosureClasses} open>
            <summary className={documentSummaryClasses}>
              Role selection and mapping
            </summary>
            <pre className="max-h-[350px] max-w-full overflow-auto text-caption">
              {JSON.stringify({ roles: pool.roles, mappings: pool.mappings }, null, 2)}
            </pre>
          </details>
          <p className={documentSupportClasses}>
            These role mappings do not prove successful credential issuance or effective AWS access.
          </p>
        </DocumentCard>
      ))}
      {result && !result.pools.length ? (
        <DocumentCard className="mb-3">
          <h3 className={documentTitleClasses}>
            No owned deployed identity pools found
          </h3>
          <p className={documentProseClasses}>
            This inspection covers resources in verified stacks for the selected deployment.
            Retained and external pools may exist separately.
          </p>
        </DocumentCard>
      ) : null}
    </>
  );
}

