import type { ProviderEvent } from "./types";

/** Control characters can expand sixfold under JSON encoding. Small text
 * chunks preserve output and remain below the durable 64KiB event limit.
 */
export async function emitText(emit: (event: ProviderEvent) => void | Promise<void>, type: ProviderEvent["type"], data: Record<string, unknown>, key: string, text: string): Promise<void> {
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 4000);
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    await emit({ type, data: { ...data, [key]: text.slice(start, end) } });
    start = end;
  }
}

export function commandSummary(command: string) {
  return { command: command.slice(0, 8000), ...(command.length > 8000 ? { commandTruncated: true } : {}) };
}
