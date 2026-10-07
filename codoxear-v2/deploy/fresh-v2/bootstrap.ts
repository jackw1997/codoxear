// Generate new private state only. Never import old accounts, catalogs or sessions.
import { mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const origin = z.string().refine(value => {
  try { const u = new URL(value); return u.protocol === "https:" && u.origin === value && !u.username && !u.password; }
  catch { return false; }
});
const guideUrl = z.string().refine(value => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
});
const Origins = z.object({ client: origin, guide: guideUrl, hubs: z.array(origin).length(2) });
const Launch = z.object({ model: z.string().min(1), reasoning_effort: z.string().optional(),
  provider_config: z.object({ base_url: z.url(), api_key: z.string().min(1), api: z.string().min(1), image_support: z.boolean().optional() }) });
const secret = () => randomBytes(32).toString("base64url");
const writePrivate = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });

export async function generateFreshState(target: string, ownerEmail = "owner@codoxear.local", preserved = join(homedir(), ".local/share/codoxear-v2/next")) {
  if (!isAbsolute(target)) throw Error("Fresh state directory must be absolute");
  if (!z.email().safeParse(ownerEmail).success) throw Error("A valid fresh owner email is required");
  let origins: z.infer<typeof Origins>, launch: z.infer<typeof Launch>;
  try {
    origins = Origins.parse(JSON.parse(await readFile(join(preserved, "public-origins.json"), "utf8")));
    launch = Launch.parse(JSON.parse(await readFile(join(preserved, "pi-litellm-launch.json"), "utf8")));
  } catch { throw Error("Preserved public origins or LiteLLM configuration is missing or invalid; no deployment generated"); }
  const directory = resolve(target);
  try { await stat(directory); throw Error("Fresh state directory already exists; refusing to merge or overwrite"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(directory, { mode: 0o700 });
  for (const child of ["config", "hub-0", "hub-1", "private", ...["computer-a", "computer-b"].flatMap(name =>
    [name, `${name}/computer`, `${name}/workspace`, `${name}/.pi`, `${name}/.pi/agent`])])
    await mkdir(join(directory, child), { mode: 0o700 });
  const password = secret();
  await writeFile(join(directory, "owner.env"), `CODOXEAR_BOOTSTRAP_EMAIL=${ownerEmail}\nCODOXEAR_BOOTSTRAP_PASSWORD=${password}\n`, { mode: 0o600, flag: "wx" });
  await writePrivate(join(directory, "private/owner.json"), { email: ownerEmail, password });
  // Retain the launch object verbatim, including the endpoint, key, model and effort.
  await writeFile(join(directory, "private/pi-litellm-launch.json"), await readFile(join(preserved, "pi-litellm-launch.json")), { mode: 0o600, flag: "wx" });
  await writePrivate(join(directory, "private/public-origins.json"), origins);
  // Computer-local defaults keep provider credentials off the Hubs. Optional
  // model limits intentionally use Pi's defaults rather than invented limits.
  for (const computer of ["computer-a", "computer-b"]) {
  await writePrivate(join(directory, `${computer}/.pi/agent/models.json`), {
    providers: { litellm: { baseUrl: launch.provider_config.base_url,
      api: launch.provider_config.api, apiKey: launch.provider_config.api_key,
      models: [{ id: launch.model, name: launch.model,
        reasoning: launch.reasoning_effort !== undefined && launch.reasoning_effort !== "off",
        input: launch.provider_config.image_support ? ["text", "image"] : ["text"] }],
    } },
  });
  await writePrivate(join(directory, `${computer}/.pi/agent/settings.json`), {
    defaultProvider: "litellm", defaultModel: launch.model,
    ...(launch.reasoning_effort ? { defaultThinkingLevel: launch.reasoning_effort } : {}),
  });
  }
  for (let i = 0; i < 2; i++) await writePrivate(join(directory, `config/hub-${i}.json`), {
    independent: true, hubId: randomUUID(), name: `Hub ${i + 1}`, origin: origins.hubs[i],
    catalog: "/state/catalog.sqlite", database: "/state/sessions.sqlite", signingKey: "/state/key.json",
    otpKey: secret(), listenHost: "0.0.0.0", listenPort: 17430, secureCookies: true,
    clientOrigins: [origins.client], clients: [{ id: "codoxear-web", redirectUris: [origins.client + "/auth-callback"] }],
  });
  // Generated gateway fragment uses preserved origins without copying certificates.
  const guide = new URL(origins.guide);
  let gateway = `${guide.origin} {\n  handle ${guide.pathname} {\n    redir ${origins.client}/ 302\n  }\n}\n`;
  for (const [url, port] of [[origins.client, 19520], [origins.hubs[0]!, 19530], [origins.hubs[1]!, 19531]] as const)
    gateway += `${url} {\n  reverse_proxy 127.0.0.1:${port} {\n    flush_interval -1\n  }\n}\n`;
  await writeFile(join(directory, "Caddyfile.fragment"), gateway, { mode: 0o600, flag: "wx" });
  await chmod(directory, 0o700);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [target, email, ...extra] = process.argv.slice(2);
  const run = async () => {
    if (!target || extra.length) throw Error("Invalid arguments");
    await generateFreshState(target, email);
    console.log("Fresh private deployment generated. Credentials and launch settings remain private. No old accounts or history imported.");
  };
  run().catch(() => { console.error("Fresh deployment generation failed; check inputs and that the destination is new. Private values were not printed."); process.exitCode = 1; });
}
