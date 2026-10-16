import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { scanCdkLinks } from "../server/source/cdk-links";
import type { SourceLocation } from "../shared/model";

function scan(body: string, linked = true) {
  const cache = path.resolve(__dirname, "../../.cache/framework-studio");
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, "scan-"));
  const text = `import { SqsSubscription as Sub } from "aws-cdk-lib/aws-sns-subscriptions";
    class Stack { constructor() { ${body}\nlinkResources(this, resources.example); } }`;
  const file = "stack.ts";
  const location: SourceLocation = { file, line: 1, column: 1, start: 0, end: 0 };
  const start = text.indexOf("linkResources(");
  const link = { ...location, start, end: text.indexOf(";", start) };
  writeFileSync(path.join(root, file), text);
  try {
    return scanCdkLinks(root, new Map([["example", { key: location, value: location, stack: {
      className: "Stack", location, members: ["topic", "queue", "dlq"].map((name) => ({ name, typeText: "unknown", category: "construct" as const, location })),
    } }]]), linked ? { example: [link] } : {});
  } finally { rmSync(root, { recursive: true }); }
}

test("CDK scan resolves named import aliases and const member aliases", () => {
  const result = scan("const target = this.queue; this.topic.addSubscription(new Sub(target));");
  assert.deepEqual(result.edges.map(({ from, to, label }) => ({ from, to, label })), [
    { from: "resource:example.topic", to: "resource:example.queue", label: "SNS subscription" },
  ]);
});

test("CDK scan omits unlinked, conditional, private, dynamic and unknown subscription relationships", () => {
  assert.equal(scan("this.topic.addSubscription(new Sub(this.queue));", false).edges.length, 0);
  assert.equal(scan(`
    if (enabled) this.topic.addSubscription(new Sub(this.queue));
    const helper = () => this.topic.addSubscription(new Sub(this.queue));
    this.topic.addSubscription(new Unknown(this.queue));
    this.topic.addSubscription(new Sub(this.privateQueue));
    this.topic.addSubscription(new Sub(this[name]));
  `).edges.length, 0);
});

test("CDK scan keeps source evidence without copying values into its JSON", () => {
  const result = scan('this.queue = new Queue(this, "queue", { deadLetterQueue: { queue: this.dlq }, token: "DO_NOT_COPY" });');
  assert.equal(result.edges[0]?.label, "Dead-letter queue");
  assert.equal(result.edges[0]?.source?.file, "stack.ts");
  assert.ok(!JSON.stringify(result).includes("DO_NOT_COPY"));
  assert.equal(Object.values(result.files)[0]?.length, 64);
});
