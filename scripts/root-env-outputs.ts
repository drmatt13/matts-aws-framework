/** Public CloudFormation outputs the development exporter maps into root .env.
 * Shared with Studio so its stack selection follows the exporter. */
export const ROOT_ENV_STACK_OUTPUTS = {
  CognitoStack: {
    UserPoolId: "USER_POOL_ID",
    UserPoolClientId: "USER_POOL_CLIENT_ID",
    UserPoolDomainUrl: "COGNITO_DOMAIN_URL",
    UserPoolDomainCloudFrontEndpoint: "COGNITO_DOMAIN_CLOUDFRONT_ENDPOINT",
    OAuthProviderRedirectUri: "OAUTH_PROVIDER_REDIRECT_URI",
  },
  DevLambdaReplayStack: {
    ReplayBucketName: "DEV_LAMBDA_REPLAY_BUCKET_NAME",
    ReplayQueueUrl: "DEV_LAMBDA_REPLAY_QUEUE_URL",
    ReplayQueueArn: "DEV_LAMBDA_REPLAY_QUEUE_ARN",
  },
  FrontendWebsiteS3Stack: {
    FrontendWebsiteBucketName: "FRONTEND_WEBSITE_BUCKET_NAME",
    CloudFrontUrl: "CLOUDFRONT_URL",
    FrontendWebsiteUrl: "CLOUDFRONT_URL",
    CloudFrontDomainName: "CLOUDFRONT_DOMAIN_NAME",
    CloudFrontId: "CLOUDFRONT_ID",
    FrontendDistributionId: "CLOUDFRONT_ID",
  },
  HttpApiGatewayStack: {
    HttpApiUrl: "HTTP_API_URL",
  },
  WebSocketApiStack: {
    WebSocketAPIEndpoint: "WEBSOCKET_API_URL",
  },
  RdsStack: {
    RdsDatabaseEndpoint: "RDS_DATABASE_ENDPOINT",
  },
};

