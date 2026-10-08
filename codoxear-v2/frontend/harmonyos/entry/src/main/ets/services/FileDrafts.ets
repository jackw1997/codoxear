import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { FileContent } from '../model/Contracts';

export interface FileDraft { server: string; session: string; key: string; base: FileContent; text: string; }
interface DraftLocation { server: string; session: string; key: string; file: string; }

// Each buffer is atomically replaced independently. Typing in one file must not
// serialize every other open buffer. The small index changes only on add/remove.
export class FileDrafts {
  private path: string = '';
  private directory: string = '';
  private entries: FileDraft[] = [];
  private locations: DraftLocation[] = [];
  private indexed: boolean = false;
  private sequence: number = 0;
  private same(left: FileDraft | DraftLocation, right: FileDraft | DraftLocation): boolean {
    return left.server === right.server && left.session === right.session && left.key === right.key;
  }
  private load(directory: string): void {
    const path = directory + '/file-drafts-index.json';
    if (this.path === path) return;
    let entries: FileDraft[] = [];
    let locations: DraftLocation[] = [];
    const indexed = fs.accessSync(path);
    if (indexed) {
      locations = JSON.parse(fs.readTextSync(path)) as DraftLocation[];
      if (!Array.isArray(locations)) throw new Error('Saved file drafts could not be read.');
      locations.forEach((location: DraftLocation) => {
        if (!/^file-draft-\d+-\d+\.json$/.test(location.file)) throw new Error('Invalid saved file draft.');
        const draft = JSON.parse(fs.readTextSync(directory + '/' + location.file)) as FileDraft;
        if (!this.same(draft, location)) throw new Error('Saved file draft identity changed.');
        entries.push(draft);
      });
    } else if (fs.accessSync(directory + '/file-drafts.json')) {
      entries = JSON.parse(fs.readTextSync(directory + '/file-drafts.json')) as FileDraft[];
    }
    if (!Array.isArray(entries)) throw new Error('Saved file drafts could not be read.');
    this.entries = entries; this.locations = locations; this.indexed = indexed;
    this.directory = directory; this.path = path;
  }
  private write(path: string, value: string): void {
    const bytes = new util.TextEncoder().encodeInto(value);
    const file = fs.openSync(path + '.tmp', fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = fs.writeSync(file.fd, bytes.buffer.slice(offset));
        if (count <= 0) throw new Error('Saved file draft write was incomplete.');
        offset += count;
      }
    } finally { fs.closeSync(file); }
    fs.renameSync(path + '.tmp', path);
  }
  private allocate(draft: FileDraft): DraftLocation {
    let name: string;
    do { name = 'file-draft-' + Date.now() + '-' + (++this.sequence) + '.json'; }
    while (fs.accessSync(this.directory + '/' + name));
    this.write(this.directory + '/' + name, JSON.stringify(draft));
    return { server: draft.server, session: draft.session, key: draft.key, file: name };
  }
  private initialize(): void {
    if (this.indexed) return;
    const locations = this.entries.map((draft: FileDraft): DraftLocation => this.allocate(draft));
    this.write(this.path, JSON.stringify(locations));
    this.locations = locations; this.indexed = true;
    // The committed index is authoritative even if legacy cleanup fails.
    try { if (fs.accessSync(this.directory + '/file-drafts.json')) fs.unlinkSync(this.directory + '/file-drafts.json'); } catch (_) {}
  }
  list(directory: string, server: string, session: string): FileDraft[] {
    if (!directory) return [];
    this.load(directory);
    return this.entries.filter((item: FileDraft) => item.server === server && item.session === session);
  }
  get(directory: string, server: string, session: string, key: string): FileDraft | undefined {
    if (!directory) return undefined;
    this.load(directory);
    return this.entries.find((item: FileDraft) => item.server === server && item.session === session && item.key === key);
  }
  put(directory: string, draft: FileDraft, dirty: boolean): void {
    if (!directory) return;
    this.load(directory);
    const old = this.entries.find((item: FileDraft) => this.same(item, draft));
    if (!dirty && !old) return;
    if (dirty && old?.text === draft.text && old.base.version === draft.base.version && old.base.text === draft.base.text) return;
    this.initialize();
    const location = this.locations.find((item: DraftLocation) => this.same(item, draft));
    const next = this.entries.filter((item: FileDraft) => !this.same(item, draft));
    if (dirty) {
      if (location) this.write(this.directory + '/' + location.file, JSON.stringify(draft));
      else {
        const created = this.allocate(draft);
        const locations = this.locations.concat([created]);
        this.write(this.path, JSON.stringify(locations));
        this.locations = locations;
      }
      next.push(draft);
    } else if (location) {
      const locations = this.locations.filter((item: DraftLocation) => !this.same(item, draft));
      this.write(this.path, JSON.stringify(locations));
      this.locations = locations;
      try { fs.unlinkSync(this.directory + '/' + location.file); } catch (_) {}
    }
    this.entries = next;
  }
}
