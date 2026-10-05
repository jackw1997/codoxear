import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";
import ts from "typescript";

// Build-time architectural check, separate from behavioral acceptance tests.
const root = resolve(import.meta.dirname, "..");
const components = new Set(["client", "hub", "computer", "identity", "server"]);
const violations: string[] = [];
let modules = 0;
async function walk(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "artifacts", ".data", ".git", "test-results"].includes(entry.name)) await walk(file);
      continue;
    }
    if (entry.name.endsWith(".py")) violations.push(`${relative(root, file)}: Python file in v2`);
    if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
    modules++;
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const owner = relative(root, file).split(sep);
    function visit(node: ts.Node): void {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith(".")) {
        const target = resolve(dirname(file), specifier.text);
        const destination = relative(root, target).split(sep);
        if (!target.startsWith(root + sep)) violations.push(`${relative(root,file)}: import escapes v2: ${specifier.text}`);
        if (owner[0] === "src" && destination[0] === "src" && components.has(destination[1]!) && owner[1] !== destination[1])
          violations.push(`${relative(root,file)}: ${owner[1]} imports component ${destination[1]}: ${specifier.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
await walk(root);
if (violations.length) throw new Error("Component boundary violations:\n" + violations.join("\n"));
console.log(`Checked ${modules} modules: imports stay inside v2 and components share libraries through explicit boundaries.`);
