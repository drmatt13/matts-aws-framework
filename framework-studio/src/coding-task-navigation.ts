import type { CodingTask } from "../shared/agent-runtime";

export const OPEN_CODING_TASK_EVENT = "studio:coding-task";
export const codingTaskSelectionKey = (repository: string) => `aws-studio:coding-task:v1:${repository}`;
export interface CodingTaskNavigation { readonly repository: string; readonly task: CodingTask }

/** Reveal an accepted task; this browser event grants no source-write authority. */
export function openCodingTask(repository: string, task: CodingTask) {
  try { localStorage.setItem(codingTaskSelectionKey(repository), task.id); } catch { /* The event still selects this task for the mounted session. */ }
  window.dispatchEvent(new window.CustomEvent<CodingTaskNavigation>(OPEN_CODING_TASK_EVENT, { detail: { repository, task } }));
}
