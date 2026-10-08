/** Docker-only startup for transport/browser fixtures. Production Computer
 * entry points never import this adapter. Attachment uses the normal API. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createComputerApi } from "../../src/computer/api.js";
import { FixtureRuntime } from "./fixture-runtime.js";

if (!existsSync("/.dockerenv"))
  throw Error("Fixture Computer runs only in Docker");
const home = resolve(
  process.env.CODOXEAR_COMPUTER_HOME ??
    join(homedir(), ".local/share/codoxear-v2/computer"),
);
const service = createComputerApi(home).service(
  (status) => console.log(JSON.stringify(status)),
  {
    runtime: (config, stateHome) => {
      if (config.runtime !== "fixture")
        throw Error("Fixture startup requires a synthetic test attachment");
      return new FixtureRuntime(join(stateHome, "fixture.sqlite"));
    },
  },
);
await service.start();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void service.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
