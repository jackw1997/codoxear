import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface ComponentDefinition {
  role: string;
  entries: string[];
  sharedLibraries: string[];
  runtimeFiles: string[];
}

/** Include type-only module edges as well: an extracted package must typecheck. */
export function moduleSpecifiers(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      imports.add(node.moduleSpecifier.text);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)) imports.add(node.argument.literal.text);
    else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
      imports.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return [...imports];
}

/** Release sources come from a reviewed Git tree, never the mutable checkout. */
export async function packageComponent(role: string, revision = "HEAD", output = resolve("releases", role)) {
  if (!["computer", "hub", "identity", "server"].includes(role))
    throw new Error("Choose computer, hub, identity or server");
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const git = (args: string[], encoding: "utf8" = "utf8") => execFileSync("git", args, { cwd: project, encoding, maxBuffer: 32 * 1024 * 1024 });
  const prefix = git(["rev-parse", "--show-prefix"]).trim();
  const commit = git(["rev-parse", revision + "^{commit}"]).trim();
  const files = new Set(git(["ls-tree", "-r", "--name-only", "--full-tree", commit]).split("\n")
    .filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length)));
  const read = (file: string) => {
    if (!files.has(file)) throw new Error("Reviewed commit lacks " + file);
    return execFileSync("git", ["show", commit + ":" + prefix + file], { cwd: project, maxBuffer: 32 * 1024 * 1024 });
  };
  const template = "components/" + role + "/";
  const definition: ComponentDefinition = JSON.parse(read(template + "component.json").toString("utf8"));
  if (definition.role !== role) throw new Error("Component role does not match its manifest");
  const sharedNames = new Set(["auth", "contracts", "domain", "persistence", "presentation", "protocol"]);
  if (definition.sharedLibraries.some((directory) => !sharedNames.has(directory.replace(/^src\//, ""))))
    throw new Error("Component declares an unowned shared library");
  const own = "src/" + role + "/";
  if (!definition.entries.length || definition.entries.some((entry) => !entry.startsWith(own)))
    throw new Error("Component entry points must belong to its own source tree");
  const runtimeFiles = role === "computer"
    ? ["runtime/oar/package.json", "runtime/oar/package-lock.json", "runtime/oar/load.mjs"] : [];
  if (JSON.stringify([...definition.runtimeFiles].sort()) !== JSON.stringify([...runtimeFiles].sort()))
    throw new Error("Component runtime ownership differs from the release allowlist");
  const source = new Map<string, Buffer>();
  const dependencies = new Set<string>();
  const queue = [...definition.entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (source.has(file)) continue;
    if (!file.endsWith(".ts") || (!file.startsWith(own) &&
      !definition.sharedLibraries.some((directory) => file.startsWith(directory + "/"))))
      throw new Error("Component source closure crosses ownership: " + file);
    const bytes = read(file);
    source.set(file, bytes);
    for (const specifier of moduleSpecifiers(file, bytes.toString("utf8"))) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        dependencies.add(specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/"));
        continue;
      }
      const candidate = posix.normalize(posix.join(posix.dirname(file), specifier));
      const resolved = [candidate.replace(/\.js$/, ".ts"), candidate, candidate + "/index.ts"]
        .find((path) => files.has(path));
      if (!resolved) throw new Error("Unresolved source dependency: " + file + " → " + specifier);
      if (!file.startsWith(own) && resolved.startsWith(own))
        throw new Error("Shared libraries cannot depend on a component: " + file + " → " + resolved);
      queue.push(resolved);
    }
  }
  const manifest = JSON.parse(read(template + "package.json").toString("utf8"));
  if (JSON.stringify(Object.keys(manifest.dependencies ?? {}).sort()) !== JSON.stringify([...dependencies].sort()))
    throw new Error("Component dependencies do not match its source closure: " + [...dependencies].sort().join(", "));
  const lock = JSON.parse(read(template + "package-lock.json").toString("utf8"));
  if (lock.name !== manifest.name || JSON.stringify(lock.packages?.[""]?.dependencies) !== JSON.stringify(manifest.dependencies))
    throw new Error("Component lockfile does not match its own manifest");
  const rootLock = JSON.parse(read("package-lock.json").toString("utf8"));
  for (const [dependency, version] of Object.entries(manifest.dependencies))
    if (version !== rootLock.packages["node_modules/" + dependency]?.version)
      throw new Error("Component dependency must equal the reviewed root lock version: " + dependency);
  const temporary = await mkdtemp(join(tmpdir(), "codoxear-package-"));
  const packageName = "codoxear-" + role;
  const packageRoot = join(temporary, packageName);
  try {
    await mkdir(packageRoot, { recursive: true });
    const exported = new Map(source);
    for (const file of ["package.json", "package-lock.json", "component.json", "tsconfig.json", "build.mjs", "Dockerfile", ".dockerignore", "README.md"])
      exported.set(file, read(template + file));
    for (const file of runtimeFiles) exported.set(file, read(file));
    for (const [file, bytes] of exported) {
      const destination = join(packageRoot, file);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const provenance = { component: role, commit, format: "source", node: manifest.engines.node,
      entries: definition.entries, sharedLibraries: definition.sharedLibraries,
      dependencies: manifest.dependencies, sources: [...source.keys()].sort(), files: [...exported.keys()].sort() };
    await writeFile(join(packageRoot, "release.json"), JSON.stringify(provenance, null, 2) + "\n");
    await mkdir(output, { recursive: true });
    const archive = resolve(output, packageName + "-source.tar.gz");
    execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", temporary, packageName]);
    const release = { ...provenance, sha256: createHash("sha256").update(await readFile(archive)).digest("hex") };
    await writeFile(resolve(output, "release.json"), JSON.stringify(release, null, 2) + "\n");
    return { archive, release };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await packageComponent(process.argv[2] ?? "", process.argv[3] ?? "HEAD", process.argv[4]);
  console.log("Packaged", result.release.component, result.release.commit, "→", result.archive);
}
