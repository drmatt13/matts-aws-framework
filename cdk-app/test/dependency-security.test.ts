import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

// Exercise the versions resolved by their existing owners, including nested installs.
const requireFrom = createRequire(path.resolve(__dirname, "../../package.json"));
function dependency(owner: string, name: string) {
  return createRequire(requireFrom.resolve(owner))(name);
}

test("qs comma serialization handles data-owned noncallable toString without swallowing legitimate errors", () => {
  const qs = dependency("express", "qs");
  const hostile = JSON.parse('{"a":["b",{"toString":"x"},"c"]}');
  assert.equal(
    qs.stringify(hostile, { arrayFormat: "comma" }),
    "a=b%2C%5Bobject%20Object%5D%2Cc",
  );
  assert.equal(
    qs.stringify(hostile, { arrayFormat: "comma", encodeValuesOnly: true }),
    "a=b,%5Bobject%20Object%5D,c",
  );
  assert.equal(
    qs.stringify(hostile, { arrayFormat: "comma", encode: false }),
    "a=b,[object Object],c",
  );
  assert.equal(
    qs.stringify(qs.parse("a[0][toString]=x", { allowPrototypes: true }), {
      arrayFormat: "comma",
    }),
    "a=%5Bobject%20Object%5D",
  );
  const sentinel = new Error("intentional");
  assert.throws(
    () =>
      qs.stringify(
        {
          a: [
            {
              toString() {
                throw sentinel;
              },
            },
          ],
        },
        { arrayFormat: "comma" },
      ),
    (e) => e === sentinel,
  );
  assert.equal(
    qs.stringify({ a: ["one", "two"] }, { arrayFormat: "comma" }),
    "a=one%2Ctwo",
  );
  assert.deepEqual(qs.parse("a[0]=one&a[1]=two"), { a: ["one", "two"] });
});

test("seroval uses intrinsic typed-array constructors across serializers", async () => {
  const s = dependency("@tanstack/router-core", "seroval");
  for (const value of [
    new Uint8Array([7, 8, 9]),
    new BigInt64Array([7n, 8n, 9n]),
  ]) {
    const intrinsic = value.constructor.name;
    Object.defineProperty(value, "constructor", {
      value: { name: "CVE_TYPED_ARRAY_CANARY()//" },
    });
    for (const code of [
      s.serialize(value),
      s.crossSerialize(value),
      s.compileJSON(s.toJSON(value)),
      await s.serializeAsync(value),
    ]) {
      assert.ok(code.includes(intrinsic));
      assert.ok(!code.includes("CVE_TYPED_ARRAY_CANARY"));
    }
  }
  const clean = new Float32Array([1.5, 2.5]);
  const restored = s.fromJSON(s.toJSON(clean));
  assert.ok(restored instanceof Float32Array);
  assert.deepEqual([...restored], [1.5, 2.5]);
  const view = new Uint8Array(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2);
  assert.deepEqual(
    [...s.fromJSON(s.toJSON(view, { compactArrayBufferViews: true }))],
    [2, 3],
  );
});

test("seroval escapes RegExp HTML delimiters including streaming output", async () => {
  const s = dependency("@tanstack/router-core", "seroval");
  const value = new RegExp("[</script>]", "i");
  const streamed = await new Promise<string>((resolve, reject) => {
    const parts: string[] = [];
    s.crossSerializeStream(value, {
      onSerialize: (code: string) => parts.push(code),
      onError: reject,
      onDone: () => resolve(parts.join("")),
    });
  });
  for (const code of [
    s.serialize(value),
    s.crossSerialize(value),
    s.compileJSON(s.toJSON(value)),
    streamed,
  ])
    assert.equal(code.includes("<"), false);
  for (const regex of [/hello/gi, /(?<word>a+)/u, /(?<=a)b/]) {
    const restored = s.fromJSON(s.toJSON(regex));
    assert.equal(restored.source, regex.source);
    assert.equal(restored.flags, regex.flags);
  }
});

test("npm undici enforces strongest SRI algorithm regardless of case", async () => {
  const { fetch, MockAgent } = dependency("jsdom", "undici");
  const mock = new MockAgent();
  mock.disableNetConnect();
  const pool = mock.get("https://sri.example.test");
  const digest = (algorithm: string, text: string) =>
    createHash(algorithm).update(text).digest("base64");
  async function read(integrity: string, body: string) {
    pool.intercept({ path: "/asset", method: "GET" }).reply(200, body);
    return (
      await fetch("https://sri.example.test/asset", {
        dispatcher: mock,
        integrity,
      })
    ).text();
  }
  try {
    for (const algorithm of ["sha256", "sha384", "sha512"])
      for (const token of [
        algorithm,
        algorithm.toUpperCase(),
        "sHa" + algorithm.slice(3),
      ]) {
        const integrity = token + "-" + digest(algorithm, "expected");
        await assert.rejects(
          read(integrity, "different"),
          (e: unknown) =>
            e instanceof Error &&
            e.cause instanceof Error &&
            e.cause.message === "integrity mismatch",
        );
        assert.equal(await read(integrity, "expected"), "expected");
      }
    await assert.rejects(
      read(
        "sha256-" +
          digest("sha256", "different") +
          " SHA512-" +
          digest("sha512", "expected"),
        "different",
      ),
      (e: unknown) =>
        e instanceof Error &&
        e.cause instanceof Error &&
        e.cause.message === "integrity mismatch",
    );
    mock.assertNoPendingInterceptors();
  } finally {
    await mock.close();
  }
});

test("glob abort stops recursive directory reads and preserves the abort reason", async () => {
  const { glob } = dependency("@vercel/nft", "glob");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "optimization-glob-"));
  try {
    for (let i = 0; i < 8; i++) {
      fs.mkdirSync(path.join(cwd, `branch-${i}`));
      fs.writeFileSync(path.join(cwd, `branch-${i}`, "leaf.txt"), "fixture");
    }
    const expected = Array.from({ length: 8 }, (_, i) => [
      `branch-${i}`,
      path.join(`branch-${i}`, "leaf.txt"),
    ]).flat();
    assert.deepEqual((await glob("**/*", { cwd })).sort(), expected.sort());
    for (const preaborted of [false, true]) {
      const controller = new AbortController(),
        reason = new Error("test cancellation");
      let reads = 0,
        after = 0,
        pending = 0;
      const counted = {
        readdir(
          directory: fs.PathLike,
          options: { encoding: "utf8"; withFileTypes: true },
          callback: (
            error: NodeJS.ErrnoException | null,
            files: fs.Dirent[],
          ) => void,
        ) {
          if (controller.signal.aborted) after++;
          reads++;
          pending++;
          if (!controller.signal.aborted) controller.abort(reason);
          fs.readdir(directory, options, (...args) => {
            try {
              callback(...args);
            } finally {
              pending--;
            }
          });
        },
      };
      if (preaborted) controller.abort(reason);
      await assert.rejects(
        glob("**/*", { cwd, fs: counted, signal: controller.signal }),
        (e) => e === reason,
      );
      for (let settled = 0; settled < 3;) {
        await new Promise((resolve) => setImmediate(resolve));
        settled = pending ? 0 : settled + 1;
      }
      assert.equal(reads, preaborted ? 0 : 1);
      assert.equal(after, 0);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
