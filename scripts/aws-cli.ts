import { execFile, execFileSync } from "node:child_process";

/**
 * How the deployment scripts reach AWS: the AWS CLI, with an explicit profile
 * and region on every call, and JSON out.
 *
 * FRAMEWORK_AWS_CLI names a Node script to run in its place. It exists for the
 * tests (and Studio's browser tests), which point it at a simulated account so
 * the scripts run end to end without touching AWS.
 */

export type AwsErrorKind = "missing-cli" | "no-credentials" | "expired" | "profile" | "denied" | "not-found" | "throttled" | "failed";

export class AwsCliError extends Error {
  constructor(readonly kind: AwsErrorKind, message: string, readonly detail: string) {
    super(message);
    this.name = "AwsCliError";
  }
}

export interface AwsTarget {
  readonly profile?: string;
  readonly region?: string;
}

const MESSAGES: Record<AwsErrorKind, string> = {
  "missing-cli": "The AWS CLI is not installed or not on PATH. Install AWS CLI v2.",
  "no-credentials": "No AWS credentials were found for the selected profile.",
  expired: "The selected profile's session has expired. Sign in again (aws sso login --profile <profile>).",
  profile: "The selected AWS profile does not exist in ~/.aws/config or ~/.aws/credentials.",
  denied: "The selected credentials are not allowed to make this call.",
  "not-found": "The requested AWS resource does not exist.",
  throttled: "AWS throttled the request. Try again shortly.",
  failed: "The AWS CLI call failed.",
};

/** The kind of failure the CLI's stderr describes; credentials text is never echoed back. */
export function classifyAwsError(stderr: string): AwsErrorKind {
  if (/ENOENT|is not recognized|command not found/i.test(stderr)) return "missing-cli";
  if (/The config profile \(.*\) could not be found|ProfileNotFound/i.test(stderr)) return "profile";
  if (/ExpiredToken|token has expired|session (associated with this profile )?has expired|Error loading SSO Token|SSO session .* expired|refresh failed|aws (sso )?login/i.test(stderr)) return "expired";
  if (/Unable to locate credentials|NoCredentials|InvalidClientTokenId|could not be found in the credential/i.test(stderr)) return "no-credentials";
  if (/AccessDenied|UnauthorizedOperation|not authorized to perform/i.test(stderr)) return "denied";
  if (/does not exist|NotFound|ResourceNotFoundException|ParameterNotFound/i.test(stderr)) return "not-found";
  if (/Throttling|Rate exceeded|TooManyRequests/i.test(stderr)) return "throttled";
  return "failed";
}

function command(): { file: string; prefix: string[] } {
  const script = process.env.FRAMEWORK_AWS_CLI;
  return script ? { file: process.execPath, prefix: [script] } : { file: "aws", prefix: [] };
}

function argv(args: readonly string[], target: AwsTarget): string[] {
  return [
    ...command().prefix, ...args, "--output", "json",
    ...(target.region ? ["--region", target.region] : []),
    ...(target.profile ? ["--profile", target.profile] : []),
  ];
}

function failure(error: unknown): AwsCliError {
  const record = error as { code?: string; stderr?: string | Buffer };
  const stderr = record.code === "ENOENT" ? "ENOENT" : String(record.stderr ?? (error instanceof Error ? error.message : ""));
  const kind = classifyAwsError(stderr);
  return new AwsCliError(kind, MESSAGES[kind], stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400));
}

function parse(output: string): any {
  return output.trim() ? JSON.parse(output) : {};
}

export function runAwsSync(args: readonly string[], target: AwsTarget = {}): any {
  try {
    return parse(execFileSync(command().file, argv(args, target), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, windowsHide: true }));
  } catch (error) {
    throw failure(error);
  }
}

export function runAws(args: readonly string[], target: AwsTarget = {}): Promise<any> {
  return new Promise((accept, reject) => {
    execFile(command().file, argv(args, target), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(failure(Object.assign(error, { stderr })));
      else {
        try { accept(parse(stdout)); } catch (parseError) { reject(failure(parseError)); }
      }
    });
  });
}

/** Every page of a paginated list, following NextToken, refusing a repeated token. */
export async function readAllPages<T>(read: (token?: string) => Promise<{ NextToken?: string } & Record<string, unknown>>, key: string): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const page = await read(token);
    items.push(...((page[key] as T[] | undefined) ?? []));
    token = page.NextToken;
    if (token && seen.has(token)) throw new AwsCliError("failed", "AWS repeated a pagination token.", "");
    if (token) seen.add(token);
  } while (token);
  return items;
}
