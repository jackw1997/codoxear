import { ApiClient } from '../services/ApiClient';
export interface ResumeCandidate { session_id: string; alias?: string; first_user_message?: string; updated_ts?: number; }
export interface CwdInfo { exists?: boolean; will_create?: boolean; git_repo?: boolean; git_branch?: string; sessions?: ResumeCandidate[]; }
export interface DirectoryChoice { name: string; path: string; }
interface DirectoryResponse { directories: DirectoryChoice[]; }
@Observed
export class LaunchContext {
  info: CwdInfo = {};
  candidates: ResumeCandidate[] = [];
  directories: DirectoryChoice[] = [];
  loading: boolean = false;
  error: string = '';
  private sequence: number = 0;
  private directorySequence: number = 0;
  cancel(): void { this.sequence++; this.directorySequence++; this.loading = false; this.info = {}; this.candidates = []; this.error = ''; }
  async load(api: ApiClient, cwd: string, backend: string): Promise<void> {
    const sequence = ++this.sequence; const connection = api.connectionVersion();
    this.info = {}; this.candidates = []; this.error = ''; this.loading = !!cwd.trim();
    if (!cwd.trim()) return;
    try {
      const result = JSON.parse(await api.request('/api/session_resume_candidates?cwd=' + encodeURIComponent(cwd.trim()) + '&agent_backend=' + encodeURIComponent(backend))) as CwdInfo;
      if (sequence !== this.sequence || connection !== api.connectionVersion()) return;
      this.info = result; this.candidates = result.sessions || [];
    } catch (reason) {
      if (sequence === this.sequence && connection === api.connectionVersion()) this.error = (reason as Error).message;
    } finally { if (sequence === this.sequence) this.loading = false; }
  }
  async suggest(api: ApiClient, cwd: string, recent: string[]): Promise<void> {
    const sequence = ++this.directorySequence; const connection = api.connectionVersion();
    const value = cwd.trim(); const slash = value.lastIndexOf('/');
    const parent = slash <= 0 ? '/' : value.slice(0, slash);
    const prefix = slash < 0 ? value : value.slice(slash + 1);
    this.directories = recent.filter((path: string) => !value || path.includes(value)).map((path: string): DirectoryChoice => { return { name: path, path: path }; });
    const result = JSON.parse(await api.request('/api/cwd-suggest?path=' + encodeURIComponent(parent) + '&prefix=' + encodeURIComponent(prefix))) as DirectoryResponse;
    if (sequence !== this.directorySequence || connection !== api.connectionVersion()) return;
    const seen = new Set(this.directories.map((item: DirectoryChoice): string => item.path));
    this.directories = this.directories.concat(result.directories.filter((item: DirectoryChoice) => !seen.has(item.path) && (!prefix || item.name.toLowerCase().startsWith(prefix.toLowerCase()))));
  }
}
