/** Small wording helpers for Deploy & Run. */

export function relativeTime(value: string | number | undefined, now = Date.now()): string {
  if (value === undefined) return "";
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(time).toLocaleDateString();
}

/** The role and session of a caller ARN: what a person recognises. */
export function callerName(arn: string | undefined): string {
  if (!arn) return "";
  const assumed = /:assumed-role\/([^/]+)\/(.+)$/.exec(arn);
  if (assumed) return `${assumed[1]} · ${assumed[2]}`;
  const user = /:user\/(.+)$/.exec(arn);
  if (user) return user[1]!;
  return arn.split(":").pop() ?? arn;
}

export function shortStack(name: string, deployment: string): string {
  return name.startsWith(`${deployment}-`) ? name.slice(deployment.length + 1) : name;
}

export function maskAccount(account: string | undefined): string {
  return account ?? "";
}

export const STATE_LABEL: Readonly<Record<string, string>> = {
  ready: "Deployed",
  "in-progress": "Updating",
  failed: "Failed",
  "rolled-back": "Rolled back",
  conflict: "Conflict",
  absent: "Not deployed",
};

export function stackTone(health: string): "ok" | "busy" | "warn" | "bad" {
  if (health === "complete") return "ok";
  if (health === "in-progress" || health === "review") return "busy";
  if (health === "rolled-back" || health === "paused") return "warn";
  return "bad";
}

export function eventTone(status: string): "ok" | "busy" | "bad" {
  if (/FAILED/.test(status)) return "bad";
  if (/IN_PROGRESS/.test(status)) return "busy";
  return "ok";
}
