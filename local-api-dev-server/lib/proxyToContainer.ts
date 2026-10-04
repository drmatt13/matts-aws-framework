import http from "node:http";
import https from "node:https";
import type { Request, Response } from "express";

type RequestWithRawBody = Request & { rawBody?: Buffer };

export default async function proxyToContainer(
  req: Request,
  res: Response,
  containerUrl: string,
  mountPath: string,
): Promise<void> {
  const [browserPathname, originalSearch = ""] = req.originalUrl.split("?");
  const normalizedMount = mountPath.replace(/\/+$/, "");
  // Express includes /api and the service mount in baseUrl. Remove only the
  // outer app mount before applying the service's own mount stripping below.
  const outerMount = normalizedMount === ""
    ? req.baseUrl ?? ""
    : req.baseUrl?.endsWith(normalizedMount)
      ? req.baseUrl.slice(0, -normalizedMount.length)
      : "";
  const originalPathname = outerMount && browserPathname.startsWith(`${outerMount}/`)
    ? browserPathname.slice(outerMount.length)
    : browserPathname;
  const strippedPath =
    originalPathname === normalizedMount
      ? "/"
      : originalPathname.startsWith(`${normalizedMount}/`)
        ? originalPathname.slice(normalizedMount.length)
        : req.path || "/";

  const url = new URL(containerUrl);
  const upstreamBasePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${upstreamBasePath}${strippedPath.startsWith("/") ? strippedPath : `/${strippedPath}`}` || "/";
  url.search = originalSearch ? `?${originalSearch}` : "";

  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (["host", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) continue;
    headers[key] = value;
  }

  const rawBody = (req as RequestWithRawBody).rawBody;
  if (rawBody) headers["content-length"] = rawBody.byteLength;

  console.log("Proxy request:", {
    method: req.method,
    incomingPath: req.originalUrl,
    strippedPath,
    target: url.toString(),
  });

  await new Promise<void>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const upstreamRequest = client.request(
      url,
      { method: req.method, headers },
      (upstreamResponse) => {
        res.status(upstreamResponse.statusCode ?? 502);
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (value === undefined || key.toLowerCase() === "transfer-encoding") continue;
          res.setHeader(key, value);
        }
        upstreamResponse.on("error", reject);
        res.on("finish", resolve);
        upstreamResponse.pipe(res);
      },
    );

    upstreamRequest.on("error", reject);
    req.on("aborted", () => upstreamRequest.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstreamRequest.destroy();
    });

    if (rawBody) {
      upstreamRequest.end(rawBody);
    } else if (["GET", "HEAD"].includes(req.method.toUpperCase()) || req.readableEnded) {
      upstreamRequest.end();
    } else {
      req.pipe(upstreamRequest);
    }
  });
}
