export type TriggerStep = "source" | "settings" | "confirm";

export interface TriggerForm {
  readonly step: TriggerStep;
  /** The service whose resources step one is showing. */
  readonly service?: string;
  readonly event: string;
  readonly resource: string;
  readonly adapter: string;
  readonly id: string;
  readonly accepts: boolean;
  readonly options: Readonly<Record<string, unknown>>;
  /** Input text as typed, for fields whose value is parsed. */
  readonly text: Readonly<Record<string, string>>;
  readonly unparsed: Readonly<Record<string, string>>;
  /** Fields switched from their guided inputs to the JSON editor. */
  readonly json: Readonly<Record<string, boolean>>;
  /** The staged binding this form replaces. */
  readonly editing?: { readonly event: string; readonly key: string };
}

