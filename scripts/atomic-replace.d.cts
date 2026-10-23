export interface AtomicReplacementOptions {
  readonly replace?: (from: string, to: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => void;
  readonly timeoutMs?: number;
}

export declare function replaceFileAtomic(from: string, to: string, options?: AtomicReplacementOptions): void;
