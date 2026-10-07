// Installed only on Computers; this package is not a Hub/Client dependency.
import { readFile } from "node:fs/promises";
const installed = JSON.parse(
  await readFile(
    new URL("node_modules/@botiverse/oar/package.json", import.meta.url),
    "utf8",
  ),
);
if (installed.version !== "0.13.3")
  throw Error("Computer requires @botiverse/oar exactly 0.13.3");
export const { runtimes } = await import("@botiverse/oar");
