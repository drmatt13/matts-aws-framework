import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { sendJson } from "../server/http";
import { EditError } from "../server/edits/io";
import { STUDIO_PROTOCOL_VERSION, studioProtocolProblem } from "../shared/protocol";

test("synchronous form validation and asynchronous planning errors share actionable JSON responses", async () => {
  const app = express();
  app.post("/sync", (_request, response) => sendJson(response, () => { throw new EditError(422, "id: This VPC identifier already exists. Choose another identifier."); }));
  app.post("/async", (_request, response) => sendJson(response, async () => { throw new EditError(409, "Source changed. Review again before applying."); }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    for (const [route, status, message] of [["sync", 422, /Choose another identifier/], ["async", 409, /Review again/]] as const) {
      const response = await fetch(`http://127.0.0.1:${address.port}/${route}`, { method: "POST" });
      assert.equal(response.status, status);
      assert.match(response.headers.get("content-type")!, /application\/json/);
      assert.match((await response.json() as { error: string }).error, message);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("stale Studio browser/server protocols block edits with a restart instruction", () => {
  assert.equal(studioProtocolProblem(STUDIO_PROTOCOL_VERSION), undefined);
  for (const version of [undefined, null, "1", "future"]) {
    assert.match(studioProtocolProblem(version)!, /Restart npm run studio/);
    assert.match(studioProtocolProblem(version)!, /No files were written/);
  }
});
