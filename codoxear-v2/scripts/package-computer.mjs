import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
// Export only committed sources; never archive local credentials or runtime data.
const repository = resolve(".."),
  revision = process.argv[2] ?? "HEAD";
const commit = execFileSync("git", ["rev-parse", revision + "^{commit}"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
execFileSync(
  "git",
  ["cat-file", "-e", commit + ":codoxear-v2/src/computer/main.ts"],
  { cwd: repository },
);
const directory = resolve("frontend/dist/client/downloads");
await mkdir(directory, { recursive: true });
execFileSync(
  "git",
  [
    "archive",
    "--format=tar.gz",
    "--prefix=codoxear-computer/",
    "--output=" + resolve(directory, "codoxear-computer-source.tar.gz"),
    commit + ":codoxear-v2",
  ],
  { cwd: repository },
);
await writeFile(
  resolve(directory, "release.json"),
  JSON.stringify({
    commit,
    format: "source",
    node: ">=22.13",
    sha256: createHash("sha256").update(await readFile(resolve(directory, "codoxear-computer-source.tar.gz"))).digest("hex"),
  }) + "\n",
);
// The combined backend-hosted preview can also expose this public artifact.
await mkdir(resolve("dist/client/downloads"), { recursive: true });
await cp(directory, resolve("dist/client/downloads"), { recursive: true });
console.log("Packaged Computer source", commit);
