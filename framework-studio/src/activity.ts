export const OPEN_ACTIVITY_EVENT = "studio:activity";

/** Reveal a job in the persistent shell tray without coupling it to a route. */
export function openActivity(job: string) {
  window.dispatchEvent(new window.CustomEvent(OPEN_ACTIVITY_EVENT, { detail: job }));
}
