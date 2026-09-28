import { linkResources, hasFrameworkResources, resolveDeploymentSecret } from "../framework/framework-resources";
import { resources } from "../../../framework-config/resources";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { eventFunction } from "../framework/framework-events";

export interface CognitoStackProps extends cdk.StackProps {
  cognitoDomainPrefix?: string;
  cognitoDomainName?: string;
  cognitoDomainCertificateArn?: string;
  googleClientId?: string;
  googleClientSecret?: cdk.SecretValue;
  callbackUrls?: string[];
  logoutUrls?: string[];
  /**
   * Every origin a browser may call this deployment's authenticated endpoints
   * from: the frontend's own URL, plus the local dev origins a dev deployment
   * serves from a laptop. Published as {@link CognitoStack.trustedOriginsCsv}.
   */
  trustedFrontendUrls?: string[];
  /**
   * Where this deployment's frontend lives, if it has an address at all — a
   * custom domain, or the generated CloudFront URL. Published as
   * {@link CognitoStack.frontendUrl} for the triggers that put a link in an
   * email; blank is the answer for a deployment with no frontend yet, and the
   * trigger then sends Cognito's own message.
   */
  frontendUrl?: string;
  retainStatefulResources?: boolean;
  skipEmailVerification?: boolean;
  /**
   * Send verification and password-reset mail through SES from this address.
   * The identity must already be verified in SES. Absent, Cognito's built-in
   * sender is used, which is limited to a small daily quota.
   */
  sesFromEmail?: string;
  /** Display name for {@link sesFromEmail}. */
  sesFromName?: string;
  /** Region of the SES identity. Defaults to this stack's region. */
  sesRegion?: string;
}

export class CognitoStack extends cdk.Stack {
  // The constructs themselves: `resources.cognito` reads its attributes from
  // these, so nothing here restates a user pool id as a string.
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  // The strings this stack answers for, which no construct can be asked for:
  // `domain.baseUrl()` is a method, and the rest are this deployment's frontend
  // settings resolved. They are resources exactly as the constructs above are —
  // `resources.cognito.userPoolDomainUrl` is the reference — and the one
  // `linkResources()` call at the end of the constructor supplies them all.
  public readonly userPoolDomainUrl: string;
  public readonly oauthProviderRedirectUri: string;
  /** Trusted browser origins, comma-separated. Without it every browser call is a 403. */
  public readonly trustedOriginsCsv: string;
  /** Where the frontend lives, or "" where this deployment has no address for it yet. */
  public readonly frontendUrl: string;
  /** `"true"` or `"false"`: whether the pre-signup trigger confirms new users itself. */
  public readonly skipEmailVerification: string;

  constructor(scope: Construct, id: string, props: CognitoStackProps) {
    super(scope, id, props);
    if (hasFrameworkResources(this) && props.googleClientId && !props.googleClientSecret) {
      const handle = resolveDeploymentSecret(this, resources.googleClientSecret, true)!;
      props = { ...props, googleClientSecret: cdk.SecretValue.secretsManager(handle.secretArn) };
    }


    const retainStatefulResources = props.retainStatefulResources ?? false;
    const callbackUrls = props.callbackUrls ?? [
      "http://localhost:3000/auth/callback",
    ];

    const logoutUrls = props.logoutUrls ?? ["http://localhost:3000/"];

    // Cognito rejects hosted-UI callback/logout URLs that are not HTTPS unless
    // they target loopback. Failing at synth turns an opaque CloudFormation
    // InvalidParameterException into a message that names the offending URL.
    const assertValidHostedUiUrl = (url: string, label: string) => {
      if (cdk.Token.isUnresolved(url)) {
        return;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new Error(`${label} must be an absolute URL. Received: ${url}`);
      }

      const isLoopback =
        parsedUrl.hostname === "localhost" ||
        parsedUrl.hostname === "127.0.0.1" ||
        parsedUrl.hostname === "[::1]" ||
        parsedUrl.hostname === "::1";

      if (parsedUrl.protocol === "http:" && !isLoopback) {
        throw new Error(
          `${label} must use HTTPS unless it targets localhost, 127.0.0.1, or [::1]. Received: ${url}`,
        );
      }
    };

    callbackUrls.forEach((url) =>
      assertValidHostedUiUrl(url, "Cognito callback URL"),
    );
    logoutUrls.forEach((url) =>
      assertValidHostedUiUrl(url, "Cognito logout URL"),
    );

    // Not "matts-aws-framework": a hosted-UI prefix may not contain "aws".
    const domainPrefix = props.cognitoDomainPrefix ?? "matts-framework";

    if (
      props.cognitoDomainName !== undefined &&
      props.cognitoDomainCertificateArn === undefined
    ) {
      throw new Error(
        "cognitoDomainCertificateArn is required when cognitoDomainName is configured.",
      );
    }

    if (
      props.cognitoDomainName === undefined &&
      props.cognitoDomainCertificateArn !== undefined
    ) {
      throw new Error(
        "cognitoDomainName is required when cognitoDomainCertificateArn is configured.",
      );
    }

    if (
      !props.cognitoDomainName &&
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domainPrefix)
    ) {
      throw new Error(
        `cognitoDomainPrefix must be 1-63 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen. Received: ${domainPrefix}`,
      );
    }

    // Cognito reports a reserved word only as "Invalid request provided:
    // AWS::Cognito::UserPoolDomain", several minutes into a deploy. Fail at
    // synth with the actual reason instead.
    const reservedWord = ["aws", "amazon", "cognito"].find((word) =>
      domainPrefix.includes(word),
    );

    if (!props.cognitoDomainName && reservedWord) {
      throw new Error(
        `cognitoDomainPrefix cannot contain the Cognito-reserved word "${reservedWord}". Received: ${domainPrefix}`,
      );
    }

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${this.stackName}-UserPool`,

      selfSignUpEnabled: true,
      signInCaseSensitive: false,

      signInAliases: {
        email: true,
      },

      autoVerify: {
        email: true,
      },

      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        givenName: {
          required: true,
          mutable: true,
        },
        familyName: {
          required: true,
          mutable: true,
        },
      },

      // Length rather than composition: 12 is OWASP ASVS's minimum, and
      // character-class rules push people toward predictable substitutions
      // without making passwords meaningfully harder to guess. The client
      // checks the same rule in register.tsx and forgot-password.tsx.
      passwordPolicy: {
        minLength: 12,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },

      // A changed email takes effect only once the new address is verified.
      // Without this, UpdateUserAttributes swaps the address immediately and
      // unverified, and every lookup by email then finds an account whose
      // owner never proved they read mail sent there.
      keepOriginal: { email: true },

      email: props.sesFromEmail
        ? cognito.UserPoolEmail.withSES({
            fromEmail: props.sesFromEmail,
            ...(props.sesFromName ? { fromName: props.sesFromName } : {}),
            sesRegion: props.sesRegion ?? this.region,
          })
        : cognito.UserPoolEmail.withCognito(),
      // Declared under framework-config/events/cognito.ts and built before this
      // stack; `eventFunction` finds each one by id, so nothing is threaded
      // through the entrypoint and Cognito's trigger names stay with Cognito.
      lambdaTriggers: {
        preSignUp: eventFunction(this, "cognito-pre-signup-trigger"),
        customMessage: eventFunction(this, "cognito-custom-message"),
        postConfirmation: eventFunction(this, "cognito-post-confirmation-trigger"),
      },

      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Authenticator apps only. SMS needs a phone number this pool never
      // collects, an SNS origination setup and per-message charges; TOTP needs
      // none of those. Users enroll from the Security panel (the /mfa route).
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },

      deletionProtection: retainStatefulResources,
      removalPolicy: retainStatefulResources
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const domain = userPool.addDomain(
      "UserPoolDomain",
      props.cognitoDomainName && props.cognitoDomainCertificateArn
        ? {
            customDomain: {
              domainName: props.cognitoDomainName,
              certificate: acm.Certificate.fromCertificateArn(
                this,
                "UserPoolDomainCertificate",
                props.cognitoDomainCertificateArn,
              ),
            },
          }
        : {
            cognitoDomain: {
              domainPrefix,
            },
          },
    );
    const userPoolDomainUrl = domain.baseUrl();

    let googleProvider: cognito.UserPoolIdentityProviderGoogle | undefined;

    if (props.googleClientId && props.googleClientSecret) {
      googleProvider = new cognito.UserPoolIdentityProviderGoogle(
        this,
        "Google",
        {
          userPool,
          clientId: props.googleClientId,
          clientSecretValue: props.googleClientSecret,
          scopes: ["openid", "email", "profile"],
          attributeMapping: {
            email: cognito.ProviderAttribute.GOOGLE_EMAIL,
            givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
            familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
            // Unmapped, Cognito records email_verified as "false" for federated
            // users: the pre-signup trigger's autoVerifyEmail does not apply on
            // the external-provider path. Every downstream verified-email gate
            // then rejects a perfectly valid Google identity.
            emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
          },
        },
      );
    }

    const supportedIdentityProviders = googleProvider
      ? [
          cognito.UserPoolClientIdentityProvider.COGNITO,
          cognito.UserPoolClientIdentityProvider.GOOGLE,
        ]
      : [cognito.UserPoolClientIdentityProvider.COGNITO];

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      generateSecret: false,
      supportedIdentityProviders,
      preventUserExistenceErrors: true,

      authFlows: {
        userSrp: true,
        userPassword: true,
        adminUserPassword: false,
        custom: false,
      },

      authSessionValidity: cdk.Duration.minutes(5),
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      // Enables refresh-token rotation: each GetTokensFromRefreshToken returns a
      // new refresh token and retires the old one after the grace period, which
      // is what lets parallel tabs with an in-flight refresh survive.
      refreshTokenRotationGracePeriod: cdk.Duration.seconds(10),
      // Precondition for the RevokeToken call in the sign-out lambda.
      enableTokenRevocation: true,

      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls,
        logoutUrls,
      },
    });

    if (googleProvider) {
      userPoolClient.node.addDependency(googleProvider);
    }

    domain.node.addDependency(userPoolClient);

    this.userPool = userPool;
    this.userPoolClient = userPoolClient;
    this.userPoolDomainUrl = userPoolDomainUrl;
    this.oauthProviderRedirectUri = `${userPoolDomainUrl}/oauth2/idpresponse`;
    this.trustedOriginsCsv = (props.trustedFrontendUrls ?? []).join(",");
    this.frontendUrl = props.frontendUrl ?? "";
    this.skipEmailVerification = props.skipEmailVerification ? "true" : "false";

    // Last, once every public field is assigned: this is what supplies
    // `resources.cognito`, and a field set after it would be a resource nothing
    // linked.
    linkResources(this, resources.cognito);

    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });

    new cdk.CfnOutput(this, "UserPoolDomainUrl", {
      value: userPoolDomainUrl,
      exportName: `${this.stackName}:UserPoolDomainUrl`,
    });

    if (props.cognitoDomainName) {
      new cdk.CfnOutput(this, "UserPoolDomainCloudFrontEndpoint", {
        value: domain.cloudFrontEndpoint,
        exportName: `${this.stackName}:UserPoolDomainCloudFrontEndpoint`,
        description:
          "CloudFront endpoint to use as the DNS target for the Cognito custom domain.",
      });
    }

    new cdk.CfnOutput(this, "OAuthProviderRedirectUri", {
      value: this.oauthProviderRedirectUri,
      exportName: `${this.stackName}:OAuthProviderRedirectUri`,
      description:
        "Redirect URI to register with external OAuth providers such as Google.",
    });
  }
}
