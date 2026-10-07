import { build } from "esbuild";
import { readFile, rm } from "node:fs/promises";
const component = JSON.parse(await readFile(new URL("./component.json", import.meta.url), "utf8"));
await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await build({ entryPoints: component.entries, outbase: "src", outdir: "dist/server", bundle: true, packages: "external", splitting: true, format: "esm", platform: "node", target: "node24", tsconfig: "tsconfig.json", chunkNames: "chunk-[hash]", logLevel: "info" });
