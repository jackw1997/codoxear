import { existsSync } from "node:fs";
import { readFile, copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { HubProviders } from "../../src/auth/providers.js";
import { atomicJson } from "../../src/persistence/files.js";

/** Update one Hub's private provider configuration without opening its catalog
 * or changing Computer/runtime settings. Never print application credentials. */
export async function configureHubProviders(root: string, hubIndex: number, providerFile: string) {
  if (!existsSync("/.dockerenv")) throw Error("Hub provider configuration requires Docker isolation");
  if (!Number.isInteger(hubIndex) || hubIndex < 0 || hubIndex > 100) throw Error("Invalid Hub index");
  const supplied = z.object({ providers: HubProviders }).strict().parse(JSON.parse(await readFile(resolve(providerFile), "utf8")));
  const file = join(resolve(root), `config/hub-${hubIndex}.json`);
  const config = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, "utf8")));
  if (config.independent !== true) throw Error("Provider setup requires an independent Hub");
  const previous = HubProviders.parse(config.providers ?? []);
  const priorFeishu = previous.find((provider) => provider.kind === "feishu");
  const nextFeishu = supplied.providers.find((provider) => provider.kind === "feishu");
  if (priorFeishu?.kind === "feishu" && priorFeishu.tenant && nextFeishu?.kind === "feishu" &&
      nextFeishu.tenant !== priorFeishu.tenant)
    throw Error("An existing organization tenant cannot be changed by replacing its connection");
  for (const old of previous) {
    const next = supplied.providers.find((provider) => provider.id === old.id);
    if (next && (next.kind !== old.kind || next.clientId !== old.clientId))
      throw Error("Use a new connection ID when changing a provider application");
    if (next?.kind === "feishu" && old.kind === "feishu" && old.tenant && next.tenant !== old.tenant)
      throw Error("An existing organization tenant cannot be changed by provider configuration");
  }
  const { trustedBrokers: _obsoleteBrokerTrust, ...independent } = config;
  const updated = { ...independent, providers: supplied.providers };
  if (JSON.stringify(config) !== JSON.stringify(updated)) {
    const backup = file + ".before-hub-providers";
    if (!existsSync(backup)) { await copyFile(file, backup); await chmod(backup, 0o600); }
    await atomicJson(file, updated);
  }
  return { hubIndex, providers: supplied.providers.map(({ id, kind }) => ({ id, kind })) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, index, providersFile, ...extra] = process.argv.slice(2);
  void (async () => {
    if (!root || index === undefined || !providersFile || extra.length) throw Error("Specify private state root, Hub index and provider configuration JSON");
    console.log(JSON.stringify({ configured: true, ...await configureHubProviders(root, Number(index), providersFile) }));
  })().catch(() => { console.error("Hub provider setup failed; inspect private configuration without exposing credentials"); process.exitCode = 1; });
}
