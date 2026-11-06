// Run in a child process so an unhandled decoder error is observable. No error listener masks a crash.
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");
const requireFrom = createRequire(
  path.join(process.argv[2], "local-api-dev-server/package.json"),
);
const express = requireFrom("express");
const kind = process.argv[3] || "json";
const encoding = process.argv[4] || "deflate";
const body = Buffer.from('{"a":1}');
const compressed =
  encoding === "gzip" ? zlib.gzipSync(body) : zlib.deflateSync(body);
const first = Buffer.concat([compressed, Buffer.from([0])]);
const trailer =
  encoding === "gzip" ? Buffer.alloc(100 * 1024, 0x58) : Buffer.alloc(1024);
const parse =
  kind === "raw" ? express.raw({ type: () => true }) : express.json();
let client;
let stage = "starting";
const watchdog = setTimeout(() => {
  console.error(`Probe timed out: ${stage}`);
  process.exit(2);
}, 5000);
watchdog.unref();
let resolveDigest;
const digestDone = new Promise((resolve) => {
  resolveDigest = resolve;
});
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  stage = "parsing";
  const hash = createHash("sha256");
  req.pipe(hash);
  hash.on("finish", () => resolveDigest(hash.digest("hex")));
  parse(req, res, (error) => {
    if (error) throw error;
    stage = "parsed";
    assert.deepEqual(req.body, kind === "raw" ? body : { a: 1 });
    if (encoding !== "gzip") client.end(trailer);
    digestDone.then(() =>
      res.end(kind === "raw" ? req.body : JSON.stringify(req.body)),
    );
  });
});
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const received = await new Promise((resolve, reject) => {
      client = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/parse",
          method: "POST",
          agent: false,
          headers: {
            "content-type": "application/json",
            "content-encoding": encoding,
            "content-length": first.length + trailer.length,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, data }));
        },
      );
      client.on("error", reject);
      if (encoding === "gzip") client.end(Buffer.concat([first, trailer]));
      else client.write(first);
    });
    stage = "response-received";
    assert.deepEqual(received, { status: 200, data: body.toString() });
    assert.equal(
      await digestDone,
      createHash("sha256").update(first).update(trailer).digest("hex"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const health = await new Promise((resolve, reject) =>
      http
        .get(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "/health",
            agent: false,
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
          },
        )
        .on("error", reject),
    );
    assert.equal(health, "ok");
    console.log(
      JSON.stringify({
        kind,
        encoding,
        status: "survived",
        siblingHash: "complete",
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
