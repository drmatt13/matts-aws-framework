import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The release includes every staged asset byte, manifest and template. */
export function assemblyDigest(directory: string): string {
  const root = realpathSync(directory);
  const hash = createHash("sha256");
  const seen = new Set<string>();
  const assertInside = (file: string): string => {
    const real = realpathSync(file);
    const inside = relative(root, real);
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(".." + sep)) throw new Error("A reviewed asset source resolves outside its saved assembly. Stage it before planning.");
    return real;
  };
  const assemblies = new Set<string>();
  const inspect = (at: string): void => {
    const manifest = assertInside(resolve(at, "manifest.json"));
    if (assemblies.has(manifest)) throw new Error("The reviewed release contains cyclic nested assemblies.");
    assemblies.add(manifest);
    const document = JSON.parse(readFileSync(manifest, "utf8"));
    for (const artifact of Object.values<any>(document.artifacts ?? {})) {
      if (artifact.type === "cdk:cloud-assembly") { inspect(assertInside(resolve(at, artifact.properties.directoryName))); continue; }
      if (artifact.type !== "cdk:asset-manifest" || !artifact.properties?.file) continue;
      const assetManifest = assertInside(resolve(at, artifact.properties.file));
      const assets = JSON.parse(readFileSync(assetManifest, "utf8"));
      for (const entry of [...Object.values<any>(assets.files ?? {}), ...Object.values<any>(assets.dockerImages ?? {})]) {
        const source = entry.source?.path ?? entry.source?.directory;
        if (!source || entry.source?.executable) throw new Error("Reviewed executable or unstaged assets are unsupported; stage fixed asset bytes before planning.");
        assertInside(resolve(assetManifest, "..", source));
      }
    }
  };
  if (existsSync(resolve(root, "manifest.json"))) inspect(root);
  const visit = (file: string, name: string): void => {
    const real = realpathSync(file);
    const inside = relative(root, real);
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(".." + sep)) throw new Error("Reviewed asset " + name + " resolves outside its saved assembly. Stage assets inside the assembly before planning.");
    if (seen.has(real)) throw new Error("Reviewed asset " + name + " has a cyclic link.");
    seen.add(real);
    const information = statSync(real);
    const link = lstatSync(file).isSymbolicLink();
    hash.update(name + "\0" + (information.mode & 0o777).toString(8) + "\0" + (link ? "link:" + readlinkSync(file) : information.isDirectory() ? "directory" : "file") + "\0");
    if (information.isDirectory()) {
      for (const entry of readdirSync(real).sort()) visit(resolve(real, entry), name + "/" + entry);
    } else hash.update(readFileSync(real));
    seen.delete(real);
  };
  for (const entry of readdirSync(root).sort()) visit(resolve(root, entry), entry);
  return hash.digest("hex");
}
