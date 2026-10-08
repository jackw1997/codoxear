import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, relative, sep, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// Build-time architectural check, separate from behavioral acceptance tests.
const root = resolve(import.meta.dirname, "..");
const skippedDirectories = new Set(["node_modules", "dist", "artifacts", "releases", ".data", ".git", "test-results"]);

export interface ComponentManifest {
  readonly role: string;
  readonly entries: readonly string[];
  readonly sharedLibraries: readonly string[];
}

interface ImportEdge {
  readonly from: string;
  readonly specifier: string;
  readonly target?: string;
}

function normalizeRelativePath(value: string): string {
  return posix.normalize(value.replaceAll("\\", "/").replace(/^\.\//, ""));
}

function importSpecifiers(file: string, sourceText: string): string[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier = node.arguments[0];
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
    if (specifier && ts.isStringLiteralLike(specifier)) found.push(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function resolveSourceImport(from: string, specifier: string, files: ReadonlyMap<string, string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = normalizeRelativePath(posix.join(posix.dirname(from), specifier));
  const candidates = [base];
  if (!posix.extname(base)) {
    candidates.push(...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${base}${extension}`));
    candidates.push(...["index.ts", "index.tsx", "index.mts", "index.cts", "index.js"].map((entry) => posix.join(base, entry)));
  } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(posix.extname(base))) {
    const withoutExtension = base.slice(0, -posix.extname(base).length);
    candidates.push(`${withoutExtension}.ts`, `${withoutExtension}.tsx`, `${withoutExtension}.mts`, `${withoutExtension}.cts`);
  }
  return candidates.find((candidate) => files.has(candidate));
}

function isCodeImport(specifier: string): boolean {
  const extension = posix.extname(specifier);
  return extension === "" || [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension);
}

function sourceEdges(files: ReadonlyMap<string, string>): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const [from, source] of files) {
    for (const specifier of importSpecifiers(from, source)) {
      if (!specifier.startsWith(".") || !isCodeImport(specifier)) continue;
      const target = resolveSourceImport(from, specifier, files);
      edges.push({ from, specifier, ...(target === undefined ? {} : { target }) });
    }
  }
  return edges;
}

function sourceOwner(path: string): string | undefined {
  const match = /^src\/([^/]+)\//.exec(path);
  return match?.[1];
}

/** Validate each component's complete relative-import closure against its manifest. */
export function auditComponentBoundaries(
  files: ReadonlyMap<string, string>,
  manifests: readonly ComponentManifest[],
): string[] {
  const edges = sourceEdges(files);
  const outgoing = new Map<string, ImportEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const violations: string[] = [];
  const roles = new Set(manifests.map((manifest) => manifest.role));
  for (const manifest of manifests) {
    const allowedRoots = [`src/${manifest.role}`, ...manifest.sharedLibraries].map(normalizeRelativePath);
    const visited = new Set<string>();
    const pending = [...manifest.entries].map(normalizeRelativePath);
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      if (!files.has(file)) {
        violations.push(`${manifest.role}: missing source entry or dependency ${file}`);
        continue;
      }
      const allowed = allowedRoots.some((allowedRoot) => file === allowedRoot || file.startsWith(`${allowedRoot}/`));
      if (!allowed) {
        const owner = sourceOwner(file);
        const reason = owner && roles.has(owner) ? `component ${owner}` : "undeclared source library";
        violations.push(`${manifest.role}: source closure reaches ${reason} ${file}`);
        continue;
      }
      for (const edge of outgoing.get(file) ?? []) {
        if (edge.target === undefined) {
          violations.push(`${manifest.role}: cannot resolve source import from ${file}: ${edge.specifier}`);
          continue;
        }
        if (sourceOwner(file) !== manifest.role && sourceOwner(edge.target) === manifest.role) {
          violations.push(`${manifest.role}: shared library cannot import its component: ${file} → ${edge.target}`);
          continue;
        }
        pending.push(edge.target);
      }
    }
  }
  return violations;
}

export function auditImports(files: ReadonlyMap<string, string>, manifests: readonly ComponentManifest[] = []): string[] {
  const violations: string[] = [];
  const edges = sourceEdges(files);
  const roles = new Set(manifests.map((manifest) => manifest.role));
  for (const [file, source] of files) {
    if (file.endsWith(".py")) violations.push(`${file}: Python file in v2`);
    const owner = file.split("/");
    for (const specifier of importSpecifiers(file, source)) {
      if (specifier.startsWith(".")) {
        const target = resolveSourceImport(file, specifier, files);
        const absoluteTarget = resolve(root, dirname(file), specifier);
        if (!absoluteTarget.startsWith(root + sep)) violations.push(`${file}: import escapes v2: ${specifier}`);
        if (target === undefined && isCodeImport(specifier)) violations.push(`${file}: cannot resolve source import: ${specifier}`);
        if (owner[0] === "frontend" && target && !target.startsWith("frontend/"))
          violations.push(`${file}: frontend imports outside its package: ${specifier}`);
        if (owner[0] === "src" && target?.startsWith("frontend/"))
          violations.push(`${file}: backend imports frontend implementation: ${specifier}`);
        const sourceRole = owner[0] === "src" ? owner[1] : undefined;
        const targetRole = target === undefined ? undefined : sourceOwner(target);
        if (sourceRole && targetRole && roles.has(sourceRole) && roles.has(targetRole) && sourceRole !== targetRole)
          violations.push(`${file}: ${sourceRole} imports component ${targetRole}: ${specifier}`);
      }
      if (owner[0] === "frontend" && owner[1] === "web" && specifier.startsWith("node:"))
        violations.push(`${file}: browser imports a Node runtime module: ${specifier}`);
    }
  }
  violations.push(...auditComponentBoundaries(files, manifests));
  return [...new Set(violations)];
}

async function walk(path: string, result: Map<string, string>): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) await walk(file, result);
      continue;
    }
    if (entry.name.endsWith(".py")) result.set(relative(root, file).split(sep).join("/"), "");
    if (/\.[cm]?[jt]s$/.test(entry.name)) result.set(relative(root, file).split(sep).join("/"), await readFile(file, "utf8"));
  }
}

async function loadManifests(): Promise<ComponentManifest[]> {
  const directory = resolve(root, "components");
  const manifests: ComponentManifest[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(directory, entry.name, "component.json");
    try {
      const value = JSON.parse(await readFile(manifestPath, "utf8")) as ComponentManifest;
      if (!value.role || !Array.isArray(value.entries) || !Array.isArray(value.sharedLibraries))
        throw new Error("expected role, entries, and sharedLibraries");
      if (value.role !== entry.name) throw new Error(`role ${value.role} does not match directory ${entry.name}`);
      manifests.push(value);
    } catch (error) {
      throw new Error(`Invalid component manifest ${relative(root, manifestPath)}: ${String(error)}`);
    }
  }
  return manifests;
}

async function main(): Promise<void> {
  const files = new Map<string, string>();
  await walk(root, files);
  const violations = auditImports(files, await loadManifests());
  if (violations.length) throw new Error("Component boundary violations:\n" + violations.join("\n"));
  console.log(`Checked ${files.size} source files: component closures stay within their declared owner and shared libraries.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
