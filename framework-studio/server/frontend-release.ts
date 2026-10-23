import { createHash, randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseTargets, TARGETS_CONTEXT_KEY } from "@repo/framework/deploy";
import { deploymentInputsFile, readCdkContext, resolveRepositoryTarget } from "@repo/framework/deploy/node";
import { collectDeploymentStacks, type DeploymentStack } from "../../scripts/resource-export";
import { DEFAULT_FRONTEND_RELEASE, FRONTEND_RELEASE_FILE, type FrontendDestination, type FrontendManifestEntry, type FrontendReleaseResult, type FrontendReleaseReview, type FrontendReleaseSettings, type FrontendSettingsReview } from "../shared/frontend-release";
import { OperationError } from "./deploy/registry";
import { runCommand, studioEnvironment, Tools, type CommandSpec, type Runner } from "./deploy/process";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => { throw new OperationError(422, message); };
const regular = (file: string) => { if (existsSync(file) && lstatSync(file).isSymbolicLink()) fail("Frontend release paths must not traverse symbolic links."); };

/** All editable paths are checkout-relative and reject linked ancestors, including linked output trees. */
export function frontendPath(root: string, relative: string, allowRoot = false): string {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(part => part === ".." || part === "")) fail("Use a nonempty repository-relative path without parent traversal.");
    const absolute = path.resolve(root, relative);
  if ((!allowRoot && absolute === path.resolve(root)) || path.relative(root, absolute).startsWith("..")) fail("Frontend paths must remain in this checkout.");
  let current = root;
  regular(current);
  for (const part of path.relative(root, absolute).split(path.sep)) { current = path.join(current, part); regular(current); }
  return absolute;
}

export function frontendSettings(value: unknown): FrontendReleaseSettings {
  const item = value as Partial<FrontendReleaseSettings> | null;
  const strings = (value: unknown, max = 50): value is string[] => Array.isArray(value) && value.length <= max && value.every(v => typeof v === "string" && v.length <= 1000 && !/[\r\n\0]/.test(v));
  if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !Object.hasOwn(DEFAULT_FRONTEND_RELEASE, key)) || typeof item.projectDirectory !== "string" || typeof item.outputDirectory !== "string" || typeof item.buildScript !== "string" || !/^[a-zA-Z0-9][\w:.-]{0,100}$/.test(item.buildScript) || !strings(item.buildArgs) || !strings(item.include) || !item.include.length || !strings(item.exclude) || typeof item.deleteRemote !== "boolean" || typeof item.prefix !== "string" || !/^(?:[A-Za-z0-9][A-Za-z0-9_.-]*\/)*$/.test(item.prefix) || !strings(item.invalidationPaths, 100) || !item.invalidationPaths.length || item.invalidationPaths.some(p => !p.startsWith("/") || p.includes("..") || /[?#]/.test(p))) fail("Use repository paths, a package.json script, include/exclude globs, a slash-terminated prefix and absolute CloudFront invalidation paths.");
  // Validation of paths does not require that the selected project exists yet.
  frontendPath(path.resolve("."), item!.projectDirectory!);
  frontendPath(path.resolve("."), item!.outputDirectory!);
  const first = item!.outputDirectory!.split("/")[0]!.toLowerCase();
  if ([".", "src", "source", "app", "pages", "components", "public", "static", "assets", "scripts", "server", "framework-config", "cdk-app", "node_modules", ".git", ".cache"].includes(first)) fail("Choose a generated build output folder such as dist, build, out or .output/public; source, public assets and configuration folders cannot be moved by a release build.");
  return item as FrontendReleaseSettings;
}

interface StoredReview { view: FrontendReleaseReview; outputsDigest: string; settingsDigest: string; buildInputsDigest: string; deleteEtags: Record<string, string>; directory: string; result: FrontendReleaseResult }
const CONTENT_TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm", ".pdf": "application/pdf", ".webmanifest": "application/manifest+json", ".mp4": "video/mp4" };

/** Builds are local effects. S3 writes and CloudFront invalidation require a second, artifact-bound approval. */
export class FrontendReleaseService {
  private readonly tools: Tools;
  private readonly run: Runner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly reviews = new Map<string, StoredReview>();
  private readonly settingsReviews = new Map<string, { view: FrontendSettingsReview; hash: string }>();
  private busy = false;
  constructor(private readonly root: string, options: { run?: Runner; env?: NodeJS.ProcessEnv } = {}) {
    this.env = options.env ?? process.env; this.run = options.run ?? runCommand; this.tools = new Tools(root, this.env);
  }
  settings(): { file: string; settings: FrontendReleaseSettings; hash: string } {
    const file = frontendPath(this.root, FRONTEND_RELEASE_FILE);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    return { file: FRONTEND_RELEASE_FILE, settings: text ? frontendSettings(JSON.parse(text)) : DEFAULT_FRONTEND_RELEASE, hash: digest(text) };
  }
  settingsReview(value: unknown, expectedHash: string): FrontendSettingsReview {
    const current = this.settings();
    if (expectedHash !== current.hash) throw new OperationError(409, "Frontend settings changed. Reload before reviewing.");
    const settings = frontendSettings(value);
    const file = frontendPath(this.root, FRONTEND_RELEASE_FILE);
    const view = { id: randomUUID(), file: FRONTEND_RELEASE_FILE, before: existsSync(file) ? readFileSync(file, "utf8") : "File absent; built-in frontend defaults currently apply.\n", after: JSON.stringify(settings, null, 2) + "\n" };
    this.settingsReviews.clear(); this.settingsReviews.set(view.id, { view, hash: current.hash }); return view;
  }
  settingsApply(id: string): { file: string } {
    if (this.busy) throw new OperationError(409, "Wait for the active frontend operation before changing settings.");
    const review = this.settingsReviews.get(id);
    if (!review || this.settings().hash !== review.hash) throw new OperationError(409, "Frontend settings review is stale. Review again.");
    const file = frontendPath(this.root, FRONTEND_RELEASE_FILE);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, review.view.after, { flag: "wx" }); renameSync(temporary, file);
    this.settingsReviews.clear(); return { file: FRONTEND_RELEASE_FILE };
  }
  private async execute(spec: CommandSpec, timeoutMs = 120_000): Promise<string> {
    const result = await this.run(spec, { timeoutMs });
    // Build tools may echo authored environment values: keep raw command output out of HTTP responses/history.
    if (result.code !== 0) throw new OperationError(422, `${spec.display} failed (${result.code ?? "could not start"}). Inspect the command locally; no dependent release step ran.`);
    return result.stdout;
  }
  private async aws(args: string[], profile: string, region: string): Promise<any> {
    const env = studioEnvironment(this.env, { profile });
    const output = await this.execute(this.tools.aws([...args, "--profile", profile, "--region", region, "--output", "json"], env));
    try { return output.trim() ? JSON.parse(output) : {}; } catch { return fail("AWS returned unreadable release evidence. No dependent step ran."); }
  }
  private async deployed(input: { deployment: string; profile: string; region: string }): Promise<{ destination: FrontendDestination; stacks: DeploymentStack[]; fingerprint: string; inputsFile: string }> {
    if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.deployment) || !/^[\w.@+-]{1,100}$/.test(input.profile) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(input.region)) fail("Choose a deployment, AWS profile and region.");
    const caller = await this.aws(["sts", "get-caller-identity"], input.profile, input.region);
    const stacks: DeploymentStack[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    do {
      const page = await this.aws(["cloudformation", "describe-stacks", "--no-paginate", ...(token ? ["--next-token", token] : [])], input.profile, input.region);
      if (!Array.isArray(page.Stacks)) fail("CloudFormation stack evidence is unavailable.");
      stacks.push(...page.Stacks); token = page.NextToken;
      if (token && tokens.has(token)) fail("CloudFormation repeated its pagination token.");
      if (token) tokens.add(token);
    } while (token);
    const { identity, stacks: owned } = collectDeploymentStacks(stacks, input.deployment);
    if (identity.account !== caller.Account || identity.region !== input.region) fail("The profile/account/region does not match deployed identity.");
    const declared = parseTargets(readCdkContext(this.root)[TARGETS_CONTEXT_KEY]).find(target => target.name === input.deployment);
    if (declared && (declared.mode !== identity.mode || (declared.account && declared.account !== identity.account) || (declared.region && declared.region !== identity.region))) fail("The declared target pins disagree with deployed identity.");
    const selection = declared ? resolveRepositoryTarget({ root: this.root, get: key => key === "deployment" ? input.deployment : key === "prodDeployment" ? identity.mode === "prod" : undefined, env: this.env }) : { inputsFile: this.env.FRAMEWORK_INPUTS_FILE ? path.resolve(this.env.FRAMEWORK_INPUTS_FILE) : deploymentInputsFile(this.root, identity.mode) };
    const website = owned.find(stack => stack.StackName === `${identity.deployment}-FrontendWebsiteS3Stack`);
    const output = (...keys: string[]) => keys.flatMap(key => website?.Outputs?.filter(item => item.OutputKey === key).map(item => item.OutputValue) ?? []).find(Boolean) ?? "";
    const bucket = output("FrontendWebsiteBucketName"); const distribution = output("CloudFrontId", "FrontendDistributionId"); const url = output("CloudFrontUrl", "FrontendWebsiteUrl");
    // Env refresh is valid for dev targets without a website. A release build below requires these destinations.
    return { destination: { deployment: identity.deployment, mode: identity.mode, profile: input.profile, account: identity.account, region: identity.region, bucket, distribution, url }, stacks, inputsFile: selection.inputsFile,
      fingerprint: digest(JSON.stringify(owned.map(stack => ({ name: stack.StackName, id: stack.StackId, status: stack.StackStatus, outputs: stack.Outputs })).sort((a, b) => String(a.id).localeCompare(String(b.id))))) };
  }
  private environmentPath(settings: FrontendReleaseSettings, mode: "dev" | "prod"): string {
    return `${settings.projectDirectory}/.env.${mode === "prod" ? "production" : "development"}.local`;
  }
  private async websiteEvidence(destination: FrontendDestination): Promise<string> {
    const resources: { ResourceType?: string; PhysicalResourceId?: string }[] = [];
    let token: string | undefined; const tokens = new Set<string>();
    do {
      const page = await this.aws(["cloudformation", "list-stack-resources", "--stack-name", `${destination.deployment}-FrontendWebsiteS3Stack`, "--no-paginate", ...(token ? ["--next-token", token] : [])], destination.profile, destination.region);
      if (!Array.isArray(page.StackResourceSummaries)) fail("Website resource ownership evidence is unavailable.");
      resources.push(...page.StackResourceSummaries); token = page.NextToken;
      if (token && tokens.has(token)) fail("CloudFormation repeated website resource pagination."); if (token) tokens.add(token);
    } while (token);
    if (!resources.some(resource => resource.ResourceType === "AWS::S3::Bucket" && resource.PhysicalResourceId === destination.bucket) || !resources.some(resource => resource.ResourceType === "AWS::CloudFront::Distribution" && resource.PhysicalResourceId === destination.distribution)) fail("Frontend outputs are not the bucket and distribution owned by this website stack. Inspect its actual resources before publication.");
    await this.aws(["s3api", "head-bucket", "--bucket", destination.bucket, "--expected-bucket-owner", destination.account], destination.profile, destination.region);
    const response = await this.aws(["cloudfront", "get-distribution", "--id", destination.distribution], destination.profile, destination.region);
    const distribution = response.Distribution;
    if (typeof distribution?.ARN !== "string" || !distribution.ARN.endsWith(`:${destination.account}:distribution/${destination.distribution}`) || distribution.DistributionConfig?.Enabled !== true) fail("CloudFront distribution account/enabled state does not match this frontend release.");
    const bucket = destination.bucket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const originPattern = new RegExp(`^${bucket}\\.s3(?:[.-][a-z0-9.-]+)?\\.amazonaws\\.com(?:\\.cn)?$`);
    if (!distribution.DistributionConfig.Origins?.Items?.some((origin: { DomainName?: string }) => typeof origin.DomainName === "string" && originPattern.test(origin.DomainName))) fail("CloudFront has no S3 origin for the reviewed bucket. Inspect routing before publication.");
    return digest(JSON.stringify({ resources: resources.sort((a, b) => String(a.PhysicalResourceId).localeCompare(String(b.PhysicalResourceId))), arn: distribution.ARN, etag: response.ETag, config: distribution.DistributionConfig }));
  }
  private buildInputsDigest(inputsFile: string, settings: FrontendReleaseSettings): string {
    return digest(JSON.stringify([inputsFile, readFileSync(inputsFile, "utf8"), readFileSync(frontendPath(this.root, "framework-config/client-environment.ts"), "utf8"), readFileSync(frontendPath(this.root, `${settings.projectDirectory}/package.json`), "utf8")]));
  }
  private async assertGeneratedOutput(settings: FrontendReleaseSettings): Promise<string> {
    // Never move an application's source or configuration out of its project,
    // even when it is untracked. git additionally protects custom source folders.
    frontendSettings(settings);
    const relative = `${settings.projectDirectory}/${settings.outputDirectory}`;
    const output = frontendPath(this.root, relative);
    const tracked = await this.run({ file: "git", args: ["ls-files", "--", relative], cwd: this.root, env: studioEnvironment(this.env), display: "git ls-files -- <frontend output>" }, { timeoutMs: 15_000 });
    if (tracked.code !== 0) fail("Unable to verify that the output folder is generated. Run this release from its Git checkout; no existing output was moved.");
    if (tracked.stdout.trim()) fail("The output folder contains tracked source. Choose an untracked generated build directory; no existing output was moved.");
    if (existsSync(output)) {
      const inspect = (folder: string) => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          const file = path.join(folder, entry.name); regular(file);
          if (entry.isDirectory()) inspect(file);
          else if (entry.name === "package.json" || entry.name.startsWith(".env") || /\.(?:tsx?|vue|svelte|prisma|sql)$/.test(entry.name)) fail("The output folder contains source/configuration files. Select a generated static output directory; nothing was moved.");
        }
      };
      inspect(output);
    }
    return output;
  }
  private async exportEnvironment(evidence: Awaited<ReturnType<FrontendReleaseService["deployed"]>>, settings: FrontendReleaseSettings): Promise<string> {
    const relative = this.environmentPath(settings, evidence.destination.mode);
    frontendPath(this.root, relative);
    const env = studioEnvironment({ ...this.env, FRAMEWORK_INPUTS_FILE: evidence.inputsFile }, { profile: evidence.destination.profile });
    await this.execute(this.tools.script("scripts/export-cdk-outputs.mjs", ["--deployment", evidence.destination.deployment, "--profile", evidence.destination.profile, "--region", evidence.destination.region, "--client-only", "--client-env-file", relative, "--expected-mode", evidence.destination.mode], env));
    return relative;
  }
  async generateEnvironment(input: { deployment: string; profile: string; region: string }): Promise<{ file: string; destination: FrontendDestination }> {
    if (this.busy) throw new OperationError(409, "A frontend operation is already running.");
    this.busy = true;
    try { const evidence = await this.deployed(input); const file = await this.exportEnvironment(evidence, this.settings().settings); return { file, destination: evidence.destination }; }
    finally { this.busy = false; }
  }
  private manifest(directory: string, settings: FrontendReleaseSettings): FrontendManifestEntry[] {
    const files: FrontendManifestEntry[] = [];
    const visit = (relative: string) => {
      const folder = path.join(directory, relative); regular(folder);
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        const file = path.join(directory, name); regular(file);
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile()) {
          if (name.split("/").some(part => part.startsWith(".env") || part === ".git" || part === "node_modules")) continue;
          if (!settings.include.some(pattern => path.matchesGlob(name, pattern)) || settings.exclude.some(pattern => path.matchesGlob(name, pattern))) continue;
          const bytes = readFileSync(file); files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
        } else fail("Build output contains an unsupported filesystem entry.");
      }
    };
    visit("");
    // HTML is uploaded last, after content-addressed assets are present.
    files.sort((a, b) => Number(a.path.endsWith(".html")) - Number(b.path.endsWith(".html")) || a.path.localeCompare(b.path));
    if (!files.length || files.length > 20_000) fail("The filtered build must contain between 1 and 20,000 regular files.");
    return files;
  }
  private stateDirectory(id: string): string { const relative = `.cache/framework-studio/frontend-releases/${id}`; const directory = frontendPath(this.root, relative); mkdirSync(directory, { recursive: true }); return directory; }
  private durableJson(file: string, value: unknown): void {
    const temporary = `${file}.${randomUUID()}.tmp`; const descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, file);
    let directory: number | undefined;
    try { directory = openSync(path.dirname(file), "r"); fsyncSync(directory); }
    catch (error) { if (!["EINVAL", "ENOTSUP", ...(process.platform === "win32" ? ["EPERM", "EACCES", "EISDIR", "EBADF"] : [])].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    finally { if (directory !== undefined) closeSync(directory); }
  }
  private save(review: StoredReview): void { this.durableJson(path.join(review.directory, "result.json"), review.result); }
  history(): { review: FrontendReleaseReview; result: FrontendReleaseResult }[] {
    const directory = frontendPath(this.root, ".cache/framework-studio/frontend-releases");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(id => /^[0-9a-f-]{36}$/.test(id)).flatMap(id => {
      try {
        const reviewFile = frontendPath(this.root, `.cache/framework-studio/frontend-releases/${id}/review.json`);
        const resultFile = frontendPath(this.root, `.cache/framework-studio/frontend-releases/${id}/result.json`);
        if (!existsSync(reviewFile)) return []; // A failed local build has no reviewed publication.
        if (!existsSync(resultFile)) throw new Error("Missing operation result");
        const review = JSON.parse(readFileSync(reviewFile, "utf8")) as FrontendReleaseReview;
        const result = JSON.parse(readFileSync(resultFile, "utf8")) as FrontendReleaseResult;
        if (review.id !== id || result.id !== id || !Array.isArray(result.uploaded) || !Array.isArray(result.deleted) || typeof review.destination?.deployment !== "string") throw new Error("Invalid operation result");
        return [{ review, result }];
      } catch { throw new OperationError(422, `Frontend release history ${id} is unreadable. Prior AWS effects are unknown; preserve its files and inspect the exact bucket/distribution before retrying.`); }
    }).sort((a, b) => b.review.createdAt.localeCompare(a.review.createdAt)).slice(0, 20);
  }
  async build(input: { deployment: string; profile: string; region: string }): Promise<FrontendReleaseReview> {
    if (this.busy) throw new OperationError(409, "A frontend operation is already running.");
    this.busy = true;
    try {
      const current = this.settings(); const settings = current.settings;
      const evidence = await this.deployed(input); const destination = evidence.destination;
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(destination.bucket) || !/^[A-Z0-9]{5,32}$/.test(destination.distribution)) fail("This deployment has no valid frontend bucket/distribution outputs. Deploy the website first; client env generation remains available separately.");
      const origin = new URL(destination.url); if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) fail("The deployed frontend URL must be an HTTPS origin.");
      const websiteFingerprint = await this.websiteEvidence(destination);
      const project = frontendPath(this.root, settings.projectDirectory);
      const pkg = JSON.parse(readFileSync(frontendPath(this.root, `${settings.projectDirectory}/package.json`), "utf8"));
      if (typeof pkg.scripts?.[settings.buildScript] !== "string") fail(`No ${settings.buildScript} script exists in the selected project's package.json.`);
      const output = await this.assertGeneratedOutput(settings);
      const buildInputsDigest = this.buildInputsDigest(evidence.inputsFile, settings);
      const id = randomUUID(); const directory = this.stateDirectory(id);
      const environmentFile = await this.exportEnvironment(evidence, settings);
      // Keep the old output as a recoverable backup; a no-op script cannot publish a stale build.
      if (existsSync(output)) { if (!lstatSync(output).isDirectory()) fail("The configured build output is not a directory."); renameSync(output, path.join(directory, "previous-output")); }
      const command = this.tools.npm(["run", settings.buildScript, ...(settings.buildArgs.length ? ["--", ...settings.buildArgs] : [])], studioEnvironment(this.env), project);
      if (!command) fail("npm-cli.js is unavailable. Install npm beside Node and retry.");
      try { await this.execute(command!, 10 * 60_000); }
      catch (error) { throw new OperationError(422, `${error instanceof Error ? error.message : error} Previous output, if present, is preserved in ${path.relative(this.root, directory).replaceAll("\\", "/")}/previous-output. Partial output is never published.`); }
      if (!existsSync(output) || !lstatSync(output).isDirectory()) fail("The build succeeded without producing the configured output directory. Nothing was published.");
      const files = this.manifest(output, settings);
      const staging = path.join(directory, "assets"); mkdirSync(staging);
      for (const file of files) { const staged = path.join(staging, file.path); mkdirSync(path.dirname(staged), { recursive: true }); cpSync(path.join(output, file.path), staged); }
      const after = await this.deployed(input);
      if (after.fingerprint !== evidence.fingerprint || await this.websiteEvidence(after.destination) !== websiteFingerprint || this.settings().hash !== current.hash || this.buildInputsDigest(after.inputsFile, settings) !== buildInputsDigest) fail("Deployment outputs/routing, public mapping/input sources or frontend settings changed during the build. Build again before publication.");
      const deleteKeys: string[] = [];
      const deleteEtags: Record<string, string> = {};
      if (settings.deleteRemote) {
        const listing = await this.aws(["s3api", "list-objects-v2", "--bucket", destination.bucket, "--prefix", settings.prefix], input.profile, input.region);
        if (listing.IsTruncated) fail("Remote deletion exceeds one page. Narrow the prefix or disable deletion; nothing was published.");
        const desired = new Set(files.map(file => settings.prefix + file.path));
        for (const item of listing.Contents ?? []) if (typeof item.Key === "string" && item.Key.startsWith(settings.prefix) && !desired.has(item.Key) && settings.include.some(pattern => path.matchesGlob(item.Key.slice(settings.prefix.length), pattern)) && !settings.exclude.some(pattern => path.matchesGlob(item.Key.slice(settings.prefix.length), pattern))) {
          if (typeof item.ETag !== "string" || !item.ETag || item.ETag === "*") fail("Remote deletion lacks object ETag evidence. Disable deletion or inspect the bucket before reviewing again.");
          deleteKeys.push(item.Key); deleteEtags[item.Key] = item.ETag;
        }
      }
      const createdAt = new Date().toISOString();
      const view: FrontendReleaseReview = { id, createdAt, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), destination, settings, environmentFile, files, deleteKeys: deleteKeys.sort(),
        commands: [`npm run ${settings.buildScript} ${settings.buildArgs.join(" ")}`.trim(), ...files.map(file => `Upload ${file.path} → s3://${destination.bucket}/${settings.prefix}${file.path}`), ...deleteKeys.map(key => `Delete s3://${destination.bucket}/${key}`), `Invalidate ${destination.distribution}: ${settings.invalidationPaths.join(", ")}`],
        warnings: ["Publication and CloudFront invalidation are separate AWS effects; infrastructure is not deployed by this operation.", "Uploads can be partial. Old assets are retained by default; replacing HTML or deleting objects has no automatic rollback. Keep a previous artifact for a separately reviewed release.", "Invalidation submission does not prove cache completion or application health. HTTP evidence is reported separately.", ...(settings.deleteRemote ? ["Remote deletion is enabled: the exact reviewed object keys will be deleted after uploads."] : [])] };
      const review: StoredReview = { view, outputsDigest: digest(evidence.fingerprint + websiteFingerprint), settingsDigest: current.hash, buildInputsDigest, deleteEtags, directory, result: { id, phase: "reviewed", uploaded: [], deleted: [], message: "Built locally and reviewed; no assets uploaded and no invalidation requested." } };
      this.durableJson(path.join(directory, "review.json"), view); this.save(review); this.reviews.set(id, review); return view;
    } finally { this.busy = false; }
  }
  result(id: string): FrontendReleaseResult {
    const result = this.reviews.get(id)?.result ?? this.history().find(entry => entry.review.id === id)?.result;
    if (!result) throw new OperationError(404, "This release has no saved result. Inspect its release directory before preparing a new review."); return result;
  }
  async publish(id: string, approval: string): Promise<FrontendReleaseResult> {
    if (this.busy) throw new OperationError(409, "A frontend operation is already running.");
    const review = this.reviews.get(id);
    if (!review || Date.parse(review.view.expiresAt) < Date.now()) throw new OperationError(409, "The frontend release review expired. Build and review again.");
    const { view } = review; const destination = view.destination;
    if (approval !== `Publish ${destination.deployment} to ${destination.bucket}`) throw new OperationError(400, "Type the exact deployment and bucket publication approval.");
    if (["complete", "uploading", "deleting", "invalidating"].includes(review.result.phase)) throw new OperationError(409, "This release is complete or has an uncertain active effect. Inspect its result before creating a new review.");
    this.busy = true;
    try {
      const evidence = await this.deployed(destination);
      if (digest(evidence.fingerprint + await this.websiteEvidence(destination)) !== review.outputsDigest || this.settings().hash !== review.settingsDigest || this.buildInputsDigest(evidence.inputsFile, view.settings) !== review.buildInputsDigest) throw new OperationError(409, "Deployment outputs/routing, public mapping/input sources or frontend settings changed. Build and review again; nothing was published.");
      const staging = path.join(review.directory, "assets");
      for (const file of view.files) { const content = readFileSync(frontendPath(this.root, path.relative(this.root, path.join(staging, file.path)).replaceAll("\\", "/"))); if (digest(content) !== file.sha256) throw new OperationError(409, "The reviewed artifact changed. Build and review again; nothing was published."); }
      const set = (patch: Partial<FrontendReleaseResult>) => { review.result = { ...review.result, ...patch }; this.save(review); };
      for (const file of view.files) {
        if (review.result.uploaded.includes(file.path)) continue;
        set({ phase: "uploading", message: `Uploading ${file.path}; an interrupted request can leave its outcome unknown.` });
        await this.aws(["s3api", "put-object", "--bucket", destination.bucket, "--key", view.settings.prefix + file.path, "--body", path.join(staging, file.path), "--expected-bucket-owner", destination.account, "--checksum-algorithm", "SHA256", "--checksum-sha256", Buffer.from(file.sha256, "hex").toString("base64"), "--content-type", CONTENT_TYPES[path.extname(file.path).toLowerCase()] ?? "application/octet-stream", "--cache-control", file.path.endsWith(".html") ? "no-cache" : "public,max-age=300"], destination.profile, destination.region);
        set({ uploaded: [...review.result.uploaded, file.path] });
      }
      set({ phase: "uploaded", message: "Assets uploaded. Remote deletion and invalidation remain separate." });
      for (const key of view.deleteKeys) {
        if (review.result.deleted.includes(key)) continue;
        set({ phase: "deleting", message: `Deleting reviewed object ${key}.` });
        await this.aws(["s3api", "delete-object", "--bucket", destination.bucket, "--key", key, "--expected-bucket-owner", destination.account, "--if-match", review.deleteEtags[key]!], destination.profile, destination.region);
        set({ deleted: [...review.result.deleted, key] });
      }
      set({ phase: "invalidating", message: "Assets are published. Requesting CloudFront invalidation; transport failure may leave that request unconfirmed." });
      const invalidation = await this.aws(["cloudfront", "create-invalidation", "--distribution-id", destination.distribution, "--invalidation-batch", JSON.stringify({ Paths: { Quantity: view.settings.invalidationPaths.length, Items: view.settings.invalidationPaths }, CallerReference: `framework-studio-${view.id}` })], destination.profile, destination.region);
      if (typeof invalidation.Invalidation?.Id !== "string") throw new Error("Invalidation response had no request ID; inspect CloudFront before retrying.");
      set({ invalidationId: invalidation.Invalidation.Id, invalidationStatus: invalidation.Invalidation.Status ?? "unknown" });
      let httpStatus: number | undefined;
      try { const response = await fetch(new URL(view.settings.prefix, destination.url), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) }); httpStatus = response.status; await response.body?.cancel(); } catch { /* Unknown HTTP outcome remains explicit. */ }
      set({ phase: "complete", ...(httpStatus ? { httpStatus } : {}), message: `Assets published; CloudFront invalidation ${review.result.invalidationId} ${review.result.invalidationStatus}. ${httpStatus ? `Frontend HTTP returned ${httpStatus}.` : "Frontend HTTP could not be verified."} Application sign-in and cache completion need separate verification.` });
      return review.result;
    } catch (error) {
      review.result = { ...review.result, phase: "failed", message: `${error instanceof Error ? error.message : error} Uploaded/deleted object lists are confirmed effects only. Retry resumes confirmed progress; an invalidation retry uses the same idempotency token. No automatic rollback ran.` }; this.save(review); throw new OperationError(422, review.result.message);
    } finally { this.busy = false; }
  }
}
