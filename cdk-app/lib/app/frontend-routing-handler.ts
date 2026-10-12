import { SignatureV4a } from "@aws-sdk/signature-v4a";
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  ListKeysCommand,
  UpdateKeysCommand,
  type CloudFrontKeyValueStoreClientConfig,
  type UpdateKeysCommandOutput,
} from "@aws-sdk/client-cloudfront-keyvaluestore";

interface RoutingProperties {
  StoreArn: string;
  Entries: { Key: string; Value: string }[];
}
export interface RoutingEvent {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: RoutingProperties;
  OldResourceProperties?: RoutingProperties;
}

export function createRoutingClient(overrides: CloudFrontKeyValueStoreClientConfig = {}) {
  // Select the JS signer explicitly: other SDKs in the workspace can load a
  // different Smithy version, whose global signer registry is a separate object.
  return new CloudFrontKeyValueStoreClient({ region: "us-east-1", ...overrides, signerConstructor: SignatureV4a });
}
const client = createRoutingClient();

/** Public routing data only. CloudFormation owns the store; deletion needs no SDK mutation. */
export async function handler(event: RoutingEvent) {
  const { StoreArn, Entries } = event.ResourceProperties;
  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: event.PhysicalResourceId ?? StoreArn };
  }
  const desired = new Map(Entries.map(({ Key, Value }) => [Key, Value]));
  // Reconcile actual contents so retries and CloudFormation rollback are
  // idempotent, including after only some of a large update succeeded.
  for (let attempt = 0; ; attempt++) {
    try {
      const metadata = await client.send(new DescribeKeyValueStoreCommand({ KvsARN: StoreArn }));
      let etag = metadata.ETag;
      if (!etag) throw new Error("CloudFront routing store returned no ETag.");
      const current = new Map<string, string>();
      let nextToken: string | undefined;
      do {
        try {
          const page = await client.send(new ListKeysCommand({ KvsARN: StoreArn, MaxResults: 50, NextToken: nextToken }));
          for (const { Key, Value } of page.Items ?? []) if (Key !== undefined && Value !== undefined) current.set(Key, Value);
          nextToken = page.NextToken;
        } catch (error) {
          // The contents API can report no keys with 404 on a new, empty store.
          if (metadata.ItemCount === 0 && error instanceof Error && error.name === "ResourceNotFoundException") break;
          throw error;
        }
      } while (nextToken);
      const changes = [
        ...Entries.filter(({ Key, Value }) => current.get(Key) !== Value).map((put) => ({ put })),
        ...[...current.keys()].filter((Key) => !desired.has(Key)).map((Key) => ({ delete: { Key } })),
      ];
      // CloudFront accepts at most 50 changed keys per request.
      for (let offset = 0; offset < changes.length; offset += 50) {
        const batch = changes.slice(offset, offset + 50);
        const puts = batch.flatMap((change) => "put" in change ? [change.put] : []);
        const deletes = batch.flatMap((change) => "delete" in change ? [change.delete] : []);
        const result: UpdateKeysCommandOutput = await client.send(new UpdateKeysCommand({
          KvsARN: StoreArn, IfMatch: etag,
          ...(puts.length ? { Puts: puts } : {}),
          ...(deletes.length ? { Deletes: deletes } : {}),
        }));
        etag = result.ETag;
        if (!etag) throw new Error("CloudFront routing update returned no ETag.");
      }
      return { PhysicalResourceId: StoreArn };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (attempt >= 7 || !["ConflictException", "ResourceNotFoundException"].includes(name)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200 * 2 ** attempt, 5_000)));
    }
  }
}
