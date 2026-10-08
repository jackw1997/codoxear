/** Disposable acceptance-only fetch proxy. Loopback Hub traffic stays direct;
 * external HTTPS retains normal certificate verification through the bridge. */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
if (!existsSync("/.dockerenv")) throw new Error("Docker only");
const require = createRequire(
  "/opt/codoxear-tools/node/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
);
const { Agent, ProxyAgent, setGlobalDispatcher } = require("undici");
const local = new Agent();
const external = new ProxyAgent("http://127.0.0.1:19590");
setGlobalDispatcher({
  dispatch(options, handler) {
    const host = new URL(String(options.origin)).hostname;
    return (
      /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) ? local : external
    ).dispatch(options, handler);
  },
  close() {
    return Promise.all([local.close(), external.close()]);
  },
  destroy() {
    return Promise.all([local.destroy(), external.destroy()]);
  },
});
