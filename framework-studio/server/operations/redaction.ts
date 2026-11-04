import { StringDecoder } from "node:string_decoder";

function forms(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))]
    .sort((a, b) => b.length - a.length);
}

function redactCredentials(text: string): string {
  return text
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(/\b((?:(?:aws[_-]?)?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token|security[_-]?token)|password|passwd|access_token|refresh_token|client_secret)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/\b(authorization\s*:\s*bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/([?&]X-Amz-(?:Credential|Signature|Security-Token)=)[^&\s]+/gi, "$1[redacted]");
}

export function redactText(text: string, secrets: readonly string[]): string {
  for (const value of forms(secrets)) text = text.split(value).join("[redacted]");
  return redactCredentials(text);
}

/** Holds only a suffix that may begin a secret, including split UTF-8/chunk boundaries. */
export class StreamingRedactor {
  private readonly values: string[];
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private safePending = "";
  private discarding = false;
  constructor(secrets: readonly string[], private readonly emit: (text: string) => void) { this.values = forms(secrets); }
  redact(text: string): string {
    for (const value of this.values) text = text.split(value).join("[redacted]");
    return redactCredentials(text);
  }
  push(chunk: string | Buffer): void {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drain(false);
  }
  flush(): void {
    this.pending += this.decoder.end(); this.drain(true);
    if (this.safePending) this.emit(redactCredentials(this.safePending));
    this.safePending = "";
  }
  private output(text: string): void {
    // Credential assignments can span transport chunks. Never emit an unfinished line.
    for (const part of text.split(/(?<=\n)/)) {
      if (!part) continue;
      if (!this.discarding) this.safePending += part;
      if (this.safePending.length > 65_536) {
        this.safePending = ""; this.discarding = true;
        this.emit("[oversized output omitted]\n");
      }
      if (part.endsWith("\n")) {
        if (!this.discarding) this.emit(redactCredentials(this.safePending));
        this.safePending = ""; this.discarding = false;
      }
    }
  }
  private drain(final: boolean): void {
    let output = "";
    let index = 0;
    while (index < this.pending.length) {
      const rest = this.pending.slice(index);
      // Prefer retaining a possible longer value over revealing its shorter prefix.
      if (!final && this.values.some(value => value.length > rest.length && value.startsWith(rest))) break;
      const match = this.values.find(value => rest.startsWith(value));
      if (match) { output += "[redacted]"; index += match.length; }
      else { output += this.pending[index]; index++; }
    }
    this.pending = this.pending.slice(index);
    if (output) this.output(output);
  }
}
