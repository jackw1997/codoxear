import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Id, DomainError } from "../../../contracts/model.js";
import { WorkspaceEdit } from "../../../contracts/workspaces.js";
import { openFile } from "./files.js";
const Root = z.object({ id: Id, name: z.string(), path: z.string(), device: z.string(), inode: z.string() });
export type WorkspaceRoot = z.infer<typeof Root>;
const rootSignals = new Map<string, AbortController>();
const registryUpdates = new Map<string, Promise<void>>();
/** Only Computer-owner operations edit this registry. Paths never arrive in member grants. */
export class WorkspaceRegistry {
  constructor(private home: string, private defaultPath: string) {}
  private get file() { return resolve(this.home, "workspace-roots.json"); }
  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = registryUpdates.get(this.file) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((done) => { release = done; });
    registryUpdates.set(this.file, pending);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (registryUpdates.get(this.file) === pending) registryUpdates.delete(this.file);
    }
  }
  authorizationSignal(id: string) {
    const key = this.file + ":" + id;
    let controller = rootSignals.get(key);
    if (!controller) { controller = new AbortController(); rootSignals.set(key, controller); }
    return controller.signal;
  }
  private async identify(id: string, name: string, path: string): Promise<WorkspaceRoot> {
    if (!isAbsolute(path)) throw new DomainError(400, "absolute_root_required", "Workspace roots require an absolute directory");
    path = resolve(path);
    const handle = await openFile(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const stat = await handle.stat({ bigint: true });
      return { id, name, path, device: String(stat.dev), inode: String(stat.ino) };
    } finally { await handle.close(); }
  }
  async roots(): Promise<WorkspaceRoot[]> {
    return this.serialized(() => this.readRoots());
  }
  private async readRoots(): Promise<WorkspaceRoot[]> {
    try { return z.array(Root).parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const roots = [await this.identify("default", "Default workspace", this.defaultPath)];
      await this.save(roots);
      return roots;
    }
  }
  private async save(roots: WorkspaceRoot[]) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomUUID();
    await writeFile(temporary, JSON.stringify(roots), { flag: "wx", mode: 0o600 });
    await rename(temporary, this.file);
  }
  async selected(id: string) {
    const root = (await this.roots()).find((row) => row.id === id);
    if (!root) throw new DomainError(403, "workspace_unavailable", "This workspace is no longer approved on the Computer");
    const actual = await this.identify(root.id, root.name, root.path);
    if (actual.device !== root.device || actual.inode !== root.inode)
      throw new DomainError(403, "workspace_replaced", "Workspace directory changed; its owner must approve it again");
    return root;
  }
  async execute(raw: unknown) {
    const input = WorkspaceEdit.parse(raw);
    return this.serialized(async () => {
    const roots = await this.readRoots();
    if (input.remove) {
      if (!input.id || input.id === "default") throw new DomainError(400, "default_root", "The default workspace cannot be removed");
      await this.save(roots.filter((row) => row.id !== input.id));
      rootSignals.get(this.file + ":" + input.id)?.abort(new DomainError(403, "workspace_revoked", "The Computer owner removed this workspace"));
    } else if (input.path) {
      const id = input.id ?? "workspace-" + randomUUID().replaceAll("-", "");
      const prior = roots.find((row) => row.id === id);
      if (input.id && !prior) throw new DomainError(404, "unknown_workspace", "Add a workspace without supplying an ID");
      if (prior && prior.path !== resolve(input.path)) throw new DomainError(409, "root_immutable", "Add a new workspace for a different directory");
      const root = await this.identify(id, input.name ?? prior?.name ?? "Workspace", input.path);
      if (prior && (prior.device !== root.device || prior.inode !== root.inode)) throw new DomainError(409, "root_replaced", "Add a new workspace ID for the replacement directory, then review its grants");
      await this.save([...roots.filter((row) => row.id !== id), root]);
    }
    const current = await this.readRoots();
    return { id: "default", path: current.find((r) => r.id === "default")?.path ?? null, roots: current };
    });
  }
}
