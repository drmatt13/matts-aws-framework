import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  ListKeysCommand,
  UpdateKeysCommand,
  type UpdateKeysCommandInput,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import { createRoutingClient, handler, type RoutingEvent } from "../lib/app/frontend-routing-handler";

const originalSend = CloudFrontKeyValueStoreClient.prototype.send;
afterEach(() => { CloudFrontKeyValueStoreClient.prototype.send = originalSend; });
const StoreArn = "arn:aws:cloudfront::111122223333:key-value-store/12345678-1234-1234-1234-123456789012";
const Entries = [{ Key: "http-api", Value: "abc.execute-api.us-east-1.amazonaws.com" }];
const event = (RequestType: RoutingEvent["RequestType"]): RoutingEvent => ({
  RequestType, ResourceProperties: { StoreArn, Entries },
});

function fakeStore(initial: { Key: string; Value: string }[] = [], loseFirstAcknowledgement = false) {
  const contents = new Map(initial.map(({ Key, Value }) => [Key, Value]));
  const updates: UpdateKeysCommandInput[] = [];
  let version = 0;
  CloudFrontKeyValueStoreClient.prototype.send = (async (command: any) => {
    assert.equal(command.input.KvsARN, StoreArn);
    if (command instanceof DescribeKeyValueStoreCommand) return { ETag: `etag-${version}`, ItemCount: contents.size };
    if (command instanceof ListKeysCommand) {
      const offset = Number(command.input.NextToken ?? 0);
      const keys = [...contents].map(([Key, Value]) => ({ Key, Value }));
      return { Items: keys.slice(offset, offset + 50), NextToken: offset + 50 < keys.length ? String(offset + 50) : undefined };
    }
    assert.ok(command instanceof UpdateKeysCommand);
    assert.equal(command.input.IfMatch, `etag-${version}`);
    assert.ok((command.input.Puts?.length ?? 0) + (command.input.Deletes?.length ?? 0) <= 50);
    for (const { Key } of command.input.Deletes ?? []) {
      assert.ok(Key !== undefined);
      assert.ok(contents.has(Key), "deleting a missing key is not idempotent");
      contents.delete(Key);
    }
    for (const { Key, Value } of command.input.Puts ?? []) {
      assert.ok(Key !== undefined && Value !== undefined);
      contents.set(Key, Value);
    }
    updates.push(command.input);
    version++;
    if (loseFirstAcknowledgement && version === 1) throw Object.assign(new Error("write committed without acknowledgement"), { name: "ConflictException" });
    return { ETag: `etag-${version}` };
  }) as never;
  return { contents, updates };
}

test("routing writes use the contents ETag and publish the actual backend address", async () => {
  const calls: unknown[] = [];
  CloudFrontKeyValueStoreClient.prototype.send = (async (command: any) => {
    calls.push(command.input);
    assert.ok(command instanceof DescribeKeyValueStoreCommand || command instanceof ListKeysCommand || command instanceof UpdateKeysCommand);
    return { ETag: "contents-etag" };
  }) as never;
  assert.deepEqual(await handler(event("Create")), { PhysicalResourceId: StoreArn });
  assert.deepEqual(calls, [
    { KvsARN: StoreArn }, { KvsARN: StoreArn, MaxResults: 50, NextToken: undefined },
    { KvsARN: StoreArn, IfMatch: "contents-etag", Puts: Entries },
  ]);
});

test("updates and rollback remove obsolete routes in the same write", async () => {
  const previous = { StoreArn, Entries: [...Entries, { Key: "agent:/chat/old", Value: "old-arn" }] };
  const store = fakeStore(previous.Entries);
  await handler({ ...event("Update"), OldResourceProperties: previous });
  assert.deepEqual(store.updates[0].Deletes, [{ Key: "agent:/chat/old" }]);
  await handler({ ...event("Update"), ResourceProperties: previous, OldResourceProperties: event("Create").ResourceProperties });
  assert.deepEqual([...store.contents], previous.Entries.map(({ Key, Value }) => [Key, Value]));
  assert.equal(store.updates[1].Deletes, undefined);
});

test("an ETag conflict retries after rereading the store", async () => {
  let reads = 0;
  let writes = 0;
  CloudFrontKeyValueStoreClient.prototype.send = (async (command: any) => {
    if (command instanceof DescribeKeyValueStoreCommand) return { ETag: `etag-${++reads}` };
    if (command instanceof ListKeysCommand) return { Items: [] };
    if (++writes === 1) throw Object.assign(new Error("concurrent change"), { name: "ConflictException" });
    assert.equal(command.input.IfMatch, "etag-2");
    return { ETag: "written" };
  }) as never;
  await handler(event("Create"));
  assert.equal(reads, 2);
  assert.equal(writes, 2);
});

test("access failures fail deployment and deletion leaves CloudFormation to delete the store", async () => {
  const denied = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
  CloudFrontKeyValueStoreClient.prototype.send = (async () => { throw denied; }) as never;
  await assert.rejects(handler(event("Create")), denied);
  assert.deepEqual(await handler({ ...event("Delete"), PhysicalResourceId: "old-store" }), { PhysicalResourceId: "old-store" });
});

test("a replacement store never deletes keys belonging to the previous store", async () => {
  const store = fakeStore();
  await handler({
    ...event("Update"), OldResourceProperties: { StoreArn: "old-store", Entries: [{ Key: "agent:/old", Value: "old" }] },
  });
  assert.equal(store.updates[0].Deletes, undefined);
});

test("a repeated create is idempotent and large routing changes respect pagination and the 50-key write limit", async () => {
  const old = Array.from({ length: 100 }, (_, index) => ({ Key: `agent:/old/${index}`, Value: "old-arn" }));
  const desired = [...Entries, ...Array.from({ length: 60 }, (_, index) => ({ Key: `agent:/new/${index}`, Value: "new-arn" }))];
  const store = fakeStore(old);
  const resource = { ...event("Create"), ResourceProperties: { StoreArn, Entries: desired } };
  await handler(resource);
  assert.deepEqual([...store.contents], desired.map(({ Key, Value }) => [Key, Value]));
  assert.equal(store.updates.length, 4);
  await handler(resource);
  assert.equal(store.updates.length, 4);
});

test("a partially committed update retries only the remaining changes", async () => {
  const desired = Array.from({ length: 61 }, (_, index) => ({ Key: `agent:/chat/${index}`, Value: "arn" }));
  const store = fakeStore([], true);
  await handler({ ...event("Create"), ResourceProperties: { StoreArn, Entries: desired } });
  assert.deepEqual([...store.contents], desired.map(({ Key, Value }) => [Key, Value]));
  assert.deepEqual(store.updates.map((update) => update.Puts?.length), [50, 11]);
});

test("the routing SDK signs requests with JavaScript SigV4a without native dependencies", async () => {
  const signingClient = createRoutingClient({
    region: "us-east-1",
    credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
    requestHandler: { handle: async (request: any) => {
      assert.match(request.headers.authorization, /^AWS4-ECDSA-P256-SHA256 /);
      return { response: { statusCode: 200, headers: { etag: "signed" }, body: Buffer.from('{}') } };
    } },
  });
  assert.equal((await signingClient.send(new DescribeKeyValueStoreCommand({ KvsARN: StoreArn }))).ETag, "signed");
});
