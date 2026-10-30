import { STUDIO_PROTOCOL_VERSION, studioProtocolProblem } from "../shared/protocol";

/**
 * The studio's server, from the page's side.
 *
 * The session token arrives in the page itself, which no other origin can
 * read, and goes back on every call.
 */

export const token = document.querySelector<HTMLMetaElement>('meta[name="studio-token"]')?.content ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const problem = body === undefined ? undefined : studioProtocolProblem(document.querySelector<HTMLMetaElement>('meta[name="studio-protocol"]')?.content);
  if (problem) throw new ApiError(409, problem);
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: { "x-studio-token": token, "x-studio-protocol": STUDIO_PROTOCOL_VERSION, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => {
    throw new ApiError(response.ok ? 502 : response.status, "Studio returned an invalid API response. Restart npm run studio in this checkout, reload the page, and retry the operation.");
  })) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, payload.error ?? response.statusText);
  return payload as T;
}

