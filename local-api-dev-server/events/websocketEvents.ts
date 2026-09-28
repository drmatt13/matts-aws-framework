import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

export const connectEvent = {
  headers: {
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Host: "your-api-id.execute-api.us-east-1.amazonaws.com",
    Origin: "http://localhost:3000",
    Pragma: "no-cache",
    "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
    "Sec-WebSocket-Key": "***************", // Masked
    "Sec-WebSocket-Version": "13",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "X-Amzn-Trace-Id": "Root=1-********-********************", // Masked
    "X-Forwarded-For": "***.***.***.***", // Masked IP
    "X-Forwarded-Port": "443",
    "X-Forwarded-Proto": "https",
  },
  multiValueHeaders: {
    "Accept-Encoding": ["gzip, deflate, br, zstd"],
    "Accept-Language": ["en-US,en;q=0.9"],
    "Cache-Control": ["no-cache"],
    Host: ["your-api-id.execute-api.us-east-1.amazonaws.com"],
    Origin: ["http://localhost:3000"],
    Pragma: ["no-cache"],
    "Sec-WebSocket-Extensions": ["permessage-deflate; client_max_window_bits"],
    "Sec-WebSocket-Key": ["***************"], // Masked
    "Sec-WebSocket-Version": ["13"],
    "User-Agent": [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    ],
    "X-Amzn-Trace-Id": ["Root=1-********-********************"], // Masked
    "X-Forwarded-For": ["***.***.***.***"], // Masked IP
    "X-Forwarded-Port": ["443"],
    "X-Forwarded-Proto": ["https"],
  },
  requestContext: {
    routeKey: "$connect",
    messageId: "",
    eventType: "CONNECT",
    extendedRequestId: "*************", // Masked
    requestTime: "16/Mar/2025:00:46:22 +0000",
    messageDirection: "IN",
    stage: "production",
    connectedAt: 1742085982306,
    requestTimeEpoch: 1742085982306,
    identity: {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      sourceIp: "***.***.***.***", // Masked IP
    },
    requestId: "*************", // Masked
    domainName: "your-api-id.execute-api.us-east-1.amazonaws.com",
    connectionId: "local-connection-id",
    apiId: "your-api-id",
  },
  isBase64Encoded: false,
} as APIGatewayProxyWebsocketEventV2;

export const disconnectEvent = {
  headers: {
    Host: "your-api-id.execute-api.us-east-1.amazonaws.com",
    "x-api-key": "",
    "X-Forwarded-For": "***.***.***.***", // Masked IP
    "x-restapi": "",
  },
  multiValueHeaders: {
    Host: ["your-api-id.execute-api.us-east-1.amazonaws.com"],
    "x-api-key": [""],
    "X-Forwarded-For": ["***.***.***.***"], // Masked IP
    "x-restapi": [""],
  },
  requestContext: {
    routeKey: "$disconnect",
    messageId: "",
    disconnectStatusCode: 1001,
    eventType: "DISCONNECT",
    extendedRequestId: "*************", // Masked
    requestTime: "16/Mar/2025:00:46:38 +0000",
    messageDirection: "IN",
    disconnectReason: "",
    stage: "production",
    connectedAt: 1742085982306,
    requestTimeEpoch: 1742085998789,
    identity: {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      sourceIp: "***.***.***.***", // Masked IP
    },
    requestId: "*************", // Masked
    domainName: "your-api-id.execute-api.us-east-1.amazonaws.com",
    connectionId: "local-connection-id",
    apiId: "your-api-id",
  },
  isBase64Encoded: false,
} as APIGatewayProxyWebsocketEventV2;

export const defaultEvent = {
  requestContext: {
    routeKey: "$default",
    messageId: "********",
    eventType: "MESSAGE",
    extendedRequestId: "********",
    requestTime: "16/Mar/2025:00:46:22 +0000",
    messageDirection: "IN",
    stage: "production",
    connectedAt: 1742085982306,
    requestTimeEpoch: 1742085982773,
    identity: {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      sourceIp: "XXX.XXX.XXX.XXX",
    },
    requestId: "********",
    domainName: "********.execute-api.us-east-1.amazonaws.com",
    connectionId: "local-connection-id",
    apiId: "********",
  },
  body: undefined,
  isBase64Encoded: false,
} as APIGatewayProxyWebsocketEventV2;
