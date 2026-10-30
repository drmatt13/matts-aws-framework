/** Bump when a running server cannot safely accept the current browser's drafts. */
// Source parameters and canonical client input references require the updated server.
export const STUDIO_PROTOCOL_VERSION = "7";
export const STUDIO_RESTART_MESSAGE = "Studio's server and browser use different declaration APIs. Restart npm run studio, reload this page, and review your changes again. No files were written.";

export function studioProtocolProblem(version: string | null | undefined): string | undefined {
  return version === STUDIO_PROTOCOL_VERSION ? undefined : STUDIO_RESTART_MESSAGE;
}
