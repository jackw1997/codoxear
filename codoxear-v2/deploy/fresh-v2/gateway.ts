// Add gateway files to an already generated fresh state; never rerun bootstrap.
import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const httpsOrigin = z.string().refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.username && !url.password; }
  catch { return false; }
});
const Origins = z.object({ client: httpsOrigin, hubs: z.array(httpsOrigin).length(2),
  guide: z.string().refine(value => {
    try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; }
    catch { return false; }
  }) });

export async function prepareFreshGateway(root: string) {
  const state = await lstat(root);
  if (!state.isDirectory() || state.isSymbolicLink()) throw Error("Fresh state root must be an existing directory");
  const origins = Origins.parse(JSON.parse(await readFile(join(root, "private/public-origins.json"), "utf8")));
  const guide = new URL(origins.guide);
  // Compose publishes these exact ports. Fail instead of silently changing origins.
  const addresses = [guide.origin, origins.client, ...origins.hubs];
  if (addresses.some((address, i) => new URL(address).port !== String(8444 + i)))
    throw Error("Gateway origins must use the preserved ports 8444 through 8447");
  const gateway = join(root, "gateway");
  for (const directory of [gateway, join(gateway, "data"), join(gateway, "config")]) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await lstat(directory);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw Error("Gateway state path is not a directory");
    }
  }
  let config = "{\n  admin off\n  auto_https disable_redirects\n}\n(fresh_tls) {\n  tls {\n    dns cloudflare {env.CF_API_TOKEN}\n    resolvers 1.1.1.1 8.8.8.8\n  }\n}\n";
  config += `${guide.origin} {\n  import fresh_tls\n  handle ${guide.pathname} {\n    redir ${origins.client}/ 302\n  }\n  handle {\n    redir ${origins.client}/ 302\n  }\n}\n`;
  for (const [address, upstream] of [[origins.client, "client:19520"], [origins.hubs[0]!, "hub-0:17430"], [origins.hubs[1]!, "hub-1:17430"]])
    config += `${address} {\n  import fresh_tls\n  reverse_proxy ${upstream} {\n    flush_interval -1\n  }\n}\n`;
  const file = join(gateway, "Caddyfile");
  try { await writeFile(file, config, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink() || await readFile(file, "utf8") !== config)
      throw Error("Existing gateway configuration differs; refusing to overwrite");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, ...extra] = process.argv.slice(2);
  const run = async () => {
    if (!root || extra.length) throw Error("Specify one existing private state root");
    await prepareFreshGateway(resolve(root));
    console.log("Fresh gateway configuration prepared; no TLS credentials printed or existing configuration overwritten.");
  };
  run().catch(() => { console.error("Fresh gateway preparation failed; inspect private origins and destination paths."); process.exitCode = 1; });
}
