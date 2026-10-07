// Run once in isolated Docker before any Hub starts. No legacy state imports.
import { existsSync } from "node:fs";
import { readFile, open, rename, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Store } from "../../src/persistence/store.js";
import { createComputer, digest } from "../../src/domain/commands.js";
import { initializeHub } from "../../src/auth/hub-setup.js";
import { Attachment } from "../../src/computer/config.js";

const Config = z.object({ independent: z.literal(true), hubId: z.string().min(1), name: z.string(), origin: z.url(),
  catalog: z.literal("/state/catalog.sqlite"), database: z.literal("/state/sessions.sqlite"), signingKey: z.literal("/state/key.json") });
const Receipt = z.object({ version: z.literal(1), status: z.literal("complete"), hubs: z.array(z.object({ hubId: z.string(), ownerId: z.string() })).length(2),
  computers: z.array(z.object({ name: z.enum(["computer-a", "computer-b"]), computerId: z.string() })).length(2) })
  .refine(receipt => new Set(receipt.computers.map(c => c.name)).size === 2 && new Set(receipt.computers.map(c => c.computerId)).size === 2);
async function json(file: string): Promise<unknown> { return JSON.parse(await readFile(file, "utf8")); }
async function durable(file: string, value: unknown, exclusive = false) {
  const temporary = exclusive ? file : file + ".complete.tmp";
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) await rename(temporary, file);
  const parent = await open(resolve(file, ".."), "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function provisionFreshState(root: string) {
  if (!existsSync("/.dockerenv")) throw Error("Fresh provisioning requires Docker isolation");
  const configs = await Promise.all([0, 1].map(async i => Config.parse(await json(join(root, `config/hub-${i}.json`)))));
  if (configs[0]!.hubId === configs[1]!.hubId) throw Error("Fresh Hubs must have independent identities");
  const receiptFile = join(root, "provision-receipt.json");
  if (existsSync(receiptFile)) {
    let receipt: z.infer<typeof Receipt>;
    try { receipt = Receipt.parse(await json(receiptFile)); }
    catch { throw Error("Provisioning is partial or invalid; stop and inspect private state without resetting it"); }
    for (let i = 0; i < 2; i++) {
      if (!existsSync(join(root, `hub-${i}/catalog.sqlite`))) throw Error("Provisioned catalog is missing");
      const store = new Store(join(root, `hub-${i}/catalog.sqlite`));
      try {
        const state = store.read(), recorded = receipt.hubs[i]!;
        const hub = state.hubs.find(h => h.id === recorded.hubId);
        const user = state.users.find(u => u.id === recorded.ownerId);
        if (recorded.hubId !== configs[i]!.hubId || !hub ||
          !user || user.passwordHash !== "")
          throw Error("Provision receipt does not match the current Hub state");
        if (i === 0) for (const entry of receipt.computers) {
          const attachment = Attachment.parse(await json(join(root, entry.name, "computer/attachment.json")));
          const computer = state.computers.find(c => c.id === entry.computerId);
          if (!computer || computer.hubId !== recorded.hubId || computer.ownerId !== hub!.ownerId || attachment.computerId !== computer.id ||
            attachment.hubId !== recorded.hubId || attachment.hubUrl !== configs[0]!.origin ||
            computer.credentialHash !== digest(attachment.credential) || attachment.runtime !== "oar" ||
            attachment.oarMaxResident !== 1 || attachment.oarPermissionPolicy !== "locally-trusted" ||
            attachment.workspacePath !== "/home/node/workspace" || attachment.nativeHome !== "/home/node" ||
            attachment.nativeStateHome !== "/home/node/computer")
            throw Error("Provision receipt does not match the current Computer attachment");
        }
      } finally { store.close(); }
    }
    return { alreadyProvisioned: true };
  }
  // No receipt means this must be pristine. Do not bootstrap an existing DB.
  for (let i = 0; i < 2; i++) if ((await readdir(join(root, `hub-${i}`))).length)
    throw Error("Hub state is not empty; refusing unattended bootstrap");
  for (const name of ["computer-a", "computer-b"]) if ((await readdir(join(root, name, "computer"))).length)
    throw Error("Computer state is not empty; refusing credential replacement");
  await durable(receiptFile, { version: 1, status: "pending" }, true);
  const hubs: Array<{ hubId: string; ownerId: string }> = [], computers: Array<{ name: "computer-a" | "computer-b"; computerId: string }> = [];
  for (let i = 0; i < 2; i++) {
    const config = configs[i]!, store = new Store(join(root, `hub-${i}/catalog.sqlite`));
    try {
      let ownerId = "";
      const attachments = store.change(state => {
        const hub = initializeHub(state, config.hubId, config.name);
        ownerId = hub.ownerId;
        if (i !== 0) return [];
        const pending = state.users.find(u => u.id === ownerId)!;
        pending.disabled = false;
        const entries = (["computer-a", "computer-b"] as const).map(name => {
          const admitted = createComputer(state, ownerId, hub.id, name === "computer-a" ? "Computer A" : "Computer B", ownerId);
          computers.push({ name, computerId: admitted.computer.id });
          return { name, attachment: Attachment.parse({ version: 1, hubUrl: config.origin, hubId: hub.id,
            computerId: admitted.computer.id, credential: admitted.credential, binding: 1,
            runtime: "oar", oarPermissionPolicy: "locally-trusted", oarMaxResident: 1,
            nativeHome: "/home/node", nativeStateHome: "/home/node/computer", workspacePath: "/home/node/workspace" }) };
        });
        pending.disabled = true;
        return entries;
      });
      for (const entry of attachments) await durable(join(root, entry.name, "computer/attachment.json"), entry.attachment, true);
      hubs.push({ hubId: config.hubId, ownerId });
    } finally { store.close(); }
  }
  await durable(receiptFile, Receipt.parse({ version: 1, status: "complete", hubs, computers }));
  return { alreadyProvisioned: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, ...extra] = process.argv.slice(2);
  const run = async () => {
    if (!root || extra.length) throw Error("Specify one private state root");
    const result = await provisionFreshState(resolve(root));
    console.log(JSON.stringify({ ok: true, alreadyProvisioned: result.alreadyProvisioned, hubs: 2, sameHubComputers: 2 }));
  };
  run().catch(() => { console.error("Fresh provisioning failed; inspect private inputs/receipt. No state reset attempted and no secrets printed."); process.exitCode = 1; });
}
