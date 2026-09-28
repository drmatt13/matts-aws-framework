import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface FrontendWebsiteS3StackProps extends cdk.StackProps {
  enableCloudFront?: boolean;
  frontendDomainName?: string;
  frontendCloudFrontCertificateArn?: string;
}

export class FrontendWebsiteS3Stack extends cdk.Stack {
  public readonly frontendWebsiteBucket: s3.Bucket;
  public readonly frontendDistribution?: cloudfront.CfnDistribution;
  public readonly cloudFrontUrl?: string;
  /** The browser security headers every response carries, pages and API alike. */
  private securityHeadersPolicyId?: string;

  public addApiOrigin(apiDomainName: string): void {
    if (!this.frontendDistribution) {
      return;
    }

    const apiOriginId = "SameOriginHttpApi";
    const rewriteFunction = new cloudfront.CfnFunction(
      this,
      "StripApiPrefixFunction",
      {
        name: `${this.stackName}-strip-api-prefix`,
        autoPublish: true,
        functionConfig: {
          comment: "Strip /api before forwarding requests to HTTP API Gateway",
          runtime: "cloudfront-js-2.0",
        },
        functionCode: [
          "function handler(event) {",
          "  var request = event.request;",
          "  request.uri = request.uri.substring(4) || '/';",
          "  return request;",
          "}",
        ].join("\n"),
      },
    );

    const distributionConfig = this.frontendDistribution
      .distributionConfig as cloudfront.CfnDistribution.DistributionConfigProperty;
    const origins = distributionConfig.origins as cloudfront.CfnDistribution.OriginProperty[];

    origins.push({
      id: apiOriginId,
      domainName: apiDomainName,
      customOriginConfig: {
        originProtocolPolicy: "https-only",
        originSslProtocols: ["TLSv1.2"],
      },
    });

    const apiBehavior: cloudfront.CfnDistribution.CacheBehaviorProperty = {
      pathPattern: "/api/*",
      targetOriginId: apiOriginId,
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: [
        "DELETE",
        "GET",
        "HEAD",
        "OPTIONS",
        "PATCH",
        "POST",
        "PUT",
      ],
      cachedMethods: ["GET", "HEAD"],
      compress: true,
      // AWS's managed pair for an API Gateway origin: nothing is cached, and
      // every viewer header, cookie and query string reaches the API except
      // Host. The local /api proxy forwards the whole request too, so a
      // handler sees the same headers (Accept, Sec-Fetch-Site, User-Agent, …)
      // in both lanes.
      cachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
      originRequestPolicyId:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
      ...(this.securityHeadersPolicyId
        ? { responseHeadersPolicyId: this.securityHeadersPolicyId }
        : {}),
      functionAssociations: [
        {
          eventType: "viewer-request",
          functionArn: rewriteFunction.attrFunctionArn,
        },
      ],
    };

    const cacheBehaviors =
      distributionConfig.cacheBehaviors as cloudfront.CfnDistribution.CacheBehaviorProperty[];
    cacheBehaviors.push(apiBehavior);
  }

  constructor(scope: Construct, id: string, props?: FrontendWebsiteS3StackProps) {
    super(scope, id, props);

    this.frontendWebsiteBucket = new s3.Bucket(
      this,
      "FrontendWebsiteBucket",
      {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      },
    );

    if (props?.enableCloudFront) {
      if (props.frontendDomainName && !props.frontendCloudFrontCertificateArn) {
        throw new Error(
          "frontendCloudFrontCertificateArn is required when frontendDomainName is configured.",
        );
      }

      const originAccessControlName = `${cdk.Names.uniqueResourceName(this, {
        maxLength: 60,
        separator: "-",
      })}-oac`;

      const originAccessControl = new cloudfront.CfnOriginAccessControl(
        this,
        "FrontendOriginAccessControl",
        {
          originAccessControlConfig: {
            name: originAccessControlName,
            description: `OAC for the ${this.stackName} frontend website bucket.`,
            originAccessControlOriginType: "s3",
            signingBehavior: "always",
            signingProtocol: "sigv4",
          },
        },
      );

      const spaRewriteFunction = new cloudfront.CfnFunction(
        this,
        "SpaRewriteFunction",
        {
          name: `${this.stackName}-spa-rewrite`,
          autoPublish: true,
          functionConfig: {
            comment: "Rewrite extensionless SPA routes to index.html",
            runtime: "cloudfront-js-2.0",
          },
          functionCode: [
            "function handler(event) {",
            "  var request = event.request;",
            "  var lastSegment = request.uri.split('/').pop();",
            "  if (!lastSegment || lastSegment.indexOf('.') === -1) {",
            "    request.uri = '/index.html';",
            "  }",
            "  return request;",
            "}",
          ].join("\n"),
        },
      );

      const securityHeadersPolicy = new cloudfront.CfnResponseHeadersPolicy(
        this,
        "FrontendSecurityHeadersPolicy",
        {
          responseHeadersPolicyConfig: {
            name: `${this.stackName}-frontend-security-headers`,
            comment: "Browser security headers for the frontend application",
            securityHeadersConfig: {
              contentSecurityPolicy: {
                contentSecurityPolicy: [
                  "default-src 'self'",
                  "base-uri 'self'",
                  // connect-src governs WebSockets as well as fetch/XHR. The
                  // API Gateway WebSocket id is assigned at deploy time and the
                  // stack is optional, so allow the region's execute-api hosts
                  // rather than coupling this stack to WebSocketApiStack.
                  `connect-src 'self' https://cognito-idp.${this.region}.amazonaws.com wss://*.execute-api.${this.region}.amazonaws.com`,
                  "font-src 'self' data:",
                  "form-action 'self'",
                  "frame-ancestors 'none'",
                  "img-src 'self' data: https:",
                  "object-src 'none'",
                  "script-src 'self'",
                  "style-src 'self' 'unsafe-inline'",
                ].join("; "),
                override: true,
              },
              contentTypeOptions: { override: true },
              frameOptions: { frameOption: "DENY", override: true },
              referrerPolicy: {
                referrerPolicy: "strict-origin-when-cross-origin",
                override: true,
              },
              strictTransportSecurity: {
                accessControlMaxAgeSec: 31_536_000,
                includeSubdomains: true,
                override: true,
                preload: false,
              },
              xssProtection: { protection: false, override: true },
            },
            customHeadersConfig: {
              items: [
                {
                  header: "Cross-Origin-Opener-Policy",
                  value: "same-origin",
                  override: true,
                },
                {
                  header: "Permissions-Policy",
                  value: "camera=(), geolocation=(), microphone=()",
                  override: true,
                },
              ],
            },
          },
        },
      );

      this.securityHeadersPolicyId = securityHeadersPolicy.ref;

      this.frontendDistribution = new cloudfront.CfnDistribution(
        this,
        "FrontendDistribution",
        {
          distributionConfig: {
            enabled: true,
            defaultRootObject: "index.html",
            ...(props.frontendDomainName
              ? {
                  aliases: [props.frontendDomainName],
                  viewerCertificate: {
                    acmCertificateArn: props.frontendCloudFrontCertificateArn,
                    minimumProtocolVersion: "TLSv1.2_2021",
                    sslSupportMethod: "sni-only",
                  },
                }
              : {}),
            origins: [
              {
                id: "FrontendWebsiteS3Origin",
                domainName:
                  this.frontendWebsiteBucket.bucketRegionalDomainName,
                originAccessControlId: originAccessControl.attrId,
                s3OriginConfig: {
                  originAccessIdentity: "",
                },
              },
            ],
            defaultCacheBehavior: {
              targetOriginId: "FrontendWebsiteS3Origin",
              responseHeadersPolicyId: securityHeadersPolicy.ref,
              viewerProtocolPolicy: "redirect-to-https",
              allowedMethods: ["GET", "HEAD", "OPTIONS"],
              cachedMethods: ["GET", "HEAD", "OPTIONS"],
              compress: true,
              forwardedValues: {
                queryString: false,
                cookies: {
                  forward: "none",
                },
              },
              functionAssociations: [
                {
                  eventType: "viewer-request",
                  functionArn: spaRewriteFunction.attrFunctionArn,
                },
              ],
            },
            cacheBehaviors: [],
          },
        },
      );

      this.frontendWebsiteBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "AllowCloudFrontOacReadFrontendWebsite",
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
          actions: ["s3:GetObject"],
          resources: [`${this.frontendWebsiteBucket.bucketArn}/*`],
          conditions: {
            StringEquals: {
              "AWS:SourceArn": `arn:aws:cloudfront::${this.account}:distribution/${this.frontendDistribution.ref}`,
            },
          },
        }),
      );

      this.cloudFrontUrl = `https://${this.frontendDistribution.attrDomainName}`;

      new cdk.CfnOutput(this, "CloudFrontUrl", {
        value: this.cloudFrontUrl,
        exportName: `${this.stackName}:CloudFrontUrl`,
      });

      new cdk.CfnOutput(this, "CloudFrontDomainName", {
        value: this.frontendDistribution.attrDomainName,
        exportName: `${this.stackName}:CloudFrontDomainName`,
      });

      new cdk.CfnOutput(this, "CloudFrontId", {
        value: this.frontendDistribution.ref,
        exportName: `${this.stackName}:CloudFrontId`,
      });
    }

    new cdk.CfnOutput(this, "FrontendWebsiteBucketName", {
      value: this.frontendWebsiteBucket.bucketName,
      exportName: `${this.stackName}:FrontendWebsiteBucketName`,
    });

    new cdk.CfnOutput(this, "FrontendWebsiteBucketArn", {
      value: this.frontendWebsiteBucket.bucketArn,
      exportName: `${this.stackName}:FrontendWebsiteBucketArn`,
    });
  }
}
