import { ConversationCopy, conversationCopy } from './ConversationCopy';
import { EditHistory } from './CodeDocument';
import { FileDrafts, FileDraft } from '../services/FileDrafts';
import { readAttachment } from '../services/AttachmentFile';
import { launchPending, launchFailed } from './SessionPresentation';
import { Activity } from './Activity';
import { ComposerChoice, supports } from './ComposerCommands';
import { util } from '@kit.ArkTS';
import { Attachment, AttachmentsResponse, UploadRequest, UnattendedConfig, ExportResponse, LaunchCatalog, GitEntry, GitChanges, GitDiff } from './Contracts';
import { fileIo as fs } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { ApiClient, ApiError } from '../services/ApiClient';
import { Session, Catalog, ChatEvent, Transcript, QueueItem, QueueResponse, DraftResponse,
  CreateSession, CreateResponse, TextRequest, SendRequest, NameRequest, QueueMutation, SearchMatch,
  SearchResponse, NeighborResponse, FileEntry, FileListing, FileContent, FileWrite, eventKey } from './Contracts';

interface SendResult { queued?: boolean; commit_unknown?: boolean; queue_len?: number; }

interface FileReferenceRequest { session_id: string; path: string; path_token?: string; }

export class FileViewState {
  editing: boolean = false;
  preview: boolean = true;
  finding: boolean = false;
  comparing: boolean = false;
  query: string = '';
  replacement: string = '';
  matchIndex: number = -1;
  normal: boolean = false;
  cursor: number = 0;
  sourceY: number = 0;
  previewY: number = 0;
}

export interface FileTab { key: string; content: FileContent; text: string; dirty: boolean; media: string; }

@Observed
export class Workspace {
  api: ApiClient = new ApiClient();
  authenticated: boolean = false;
  sessions: Session[] = [];
  selected: Session | undefined = undefined;
  events: ChatEvent[] = [];
  queue: QueueItem[] = [];
  queueChanging: boolean = false;
  private queueReadEpoch: number = 0;
  private catalogReadEpoch: number = 0;
  draft: string = '';
  error: string = '';
  connectionStatus: string = '';
  notice: string = '';
  busy: boolean = false;
  activity: Activity = new Activity();
  sending: boolean = false;
  uploading: boolean = false;
  creating: boolean = false;
  private pendingLaunch: CreateResponse | undefined = undefined;
  private pendingLaunchEpoch: number = 0;
  private pendingLaunchName: string = '';
  hasOlder: boolean = false;
  browsingHistory: boolean = false;
  private searchEpoch: number = 0;
  private fileEpoch: number = 0;
  sidebar: boolean = false;
  panel: string = '';
  searchMatches: SearchMatch[] = [];
  searchQuery: string = "";
  searchIndex: number = -1;
  searchTotal: number = 0;
  searchBase: number = 0;
  searchLoading: boolean = false;
  files: FileEntry[] = [];
  gitFiles: GitEntry[] = [];
  gitDiff: string = '';
  gitPath: string = '';
  activeFile: FileContent | undefined = undefined;
  fileTabs: FileTab[] = [];
  private sessionFiles: Map<string, FileTab[]> = new Map();
  fileText: string = '';
  fileDirty: boolean = false;
  fileLocation: string = '';
  recoveryFiles: FileDraft[] = [];
  private fileViews: Map<string, FileViewState> = new Map();
  private fileHistories: Map<string, EditHistory> = new Map();
  private fileDrafts: FileDrafts = new FileDrafts();
  localMedia: string = '';
  cacheDir: string = '';
  private pendingSends: Set<string> = new Set();
  private pendingUploads: Set<string> = new Set();
  details: string = '';
  settingBusy: boolean = false;
  attachments: Attachment[] = [];
  private attachmentRead: number = 0;
  unattended: UnattendedConfig = { enabled: false, request: '', cooldown_minutes: 5, remaining_injections: 10 };
  recentCwds: string[] = [];
  tmuxAvailable: boolean = false;
  launchDefaults: LaunchCatalog = { default_backend: 'pi', backends: {} };
  private liveCursor: string = '';
  private closeStream: (() => void) | undefined = undefined;
  private streamActive: boolean = false;
  private historyRequest: number = 0;
  private historyCursor: string = '';
  private epoch: number = 0;
  private pollTimer: number = -1;
  private draftTimers: Map<string, number> = new Map();
  private draftWrites: Map<string, Promise<void>> = new Map();
  private draftPending: Map<string, string> = new Map();
  private draftStamps: Map<string, number> = new Map();
  private draftBaselines: Map<string, string> = new Map();
  private draftRevisions: Map<string, number> = new Map();
  private transcriptBinding: string = '';
  storageDir: string = '';
  private endpointKey: string = '';
  private authEpoch: number = 0;
  private polling: boolean = false;
  private drafts: Map<string, string> = new Map();

  path(suffix: string, sessionId?: string): string {
    const id = sessionId || this.selected?.session_id;
    if (!id) throw new Error('Select a session first.');
    return '/api/sessions/' + encodeURIComponent(id) + '/' + suffix;
  }

  authenticationVersion(): number { return this.authEpoch; }
  async openNotification(server: string, sessionId: string): Promise<boolean> {
    if (!this.authenticated || this.api.address('/api/me') !== server) return false;
    const generation = this.authEpoch;
    await this.refresh();
    if (generation !== this.authEpoch) return false;
    const session = this.sessions.find((item: Session) => item.session_id === sessionId);
    if (session) await this.select(session);
    else { this.notice = 'This session is no longer available.'; this.sidebar = true; }
    return true;
  }
  onAuthenticationLost: () => void = () => {};
  onTranscriptChanged: (reset: boolean) => void = () => {};

  private clearConnection(): void {
    this.authEpoch++;
    this.dispose();
    this.authenticated = false; this.selected = undefined; this.connectionStatus = '';
    this.events = []; this.sessions = []; this.queue = []; this.queueChanging = false; this.attachments = [];
    this.sessionFiles.clear(); this.fileViews.clear(); this.recoveryFiles = []; this.fileHistories.clear(); this.fileLocation = ''; this.fileTabs = []; this.activeFile = undefined; this.fileText = ''; this.fileDirty = false; this.localMedia = '';
    this.files = []; this.gitFiles = []; this.gitDiff = ''; this.details = ''; this.clearSearch();
    this.panel = ''; this.sidebar = false; this.drafts.clear(); this.draftWrites.clear(); this.draftPending.clear(); this.draftStamps.clear(); this.draftBaselines.clear(); this.draftRevisions.clear(); this.draft = '';
    this.pendingSends.clear(); this.pendingUploads.clear(); this.sending = false; this.settingBusy = false; this.uploading = false; this.notice = ''; this.busy = false;
    this.activity = new Activity(); this.liveCursor = ''; this.historyCursor = ''; this.transcriptBinding = '';
    this.hasOlder = false; this.browsingHistory = false;
    this.creating = false; this.pendingLaunch = undefined;
  }

  async login(endpoint: string, password: string): Promise<void> {
    const client = new ApiClient();
    client.configure(endpoint);
    this.api.invalidate();
    this.clearConnection();
    this.api = client;
    client.onUnauthorized = (): void => {
      if (this.api !== client) return;
      this.clearConnection();
      this.error = 'Your login expired. Sign in again. Your local drafts are preserved.';
      this.onAuthenticationLost();
    };
    const generation = this.authEpoch;
    this.endpointKey = encodeURIComponent(endpoint.trim().replace(/\/+$/, ''));
    await client.login(password);
    if (generation !== this.authEpoch) return;
    await this.refresh();
    if (generation !== this.authEpoch) return;
    this.error = ''; this.authenticated = true;
    this.sidebar = this.sessions.length > 0;
    this.start();
  }

  async logout(): Promise<void> {
    const client = this.api;
    this.clearConnection();
    await client.logout();
  }

  start(): void {
    if (this.pollTimer !== -1) return;
    this.pollTimer = setInterval(() => { this.poll(); }, 1800);
  }

  dispose(): void {
    this.epoch++;
    this.closeStream?.(); this.closeStream = undefined; this.streamActive = false;
    if (this.pollTimer !== -1) clearInterval(this.pollTimer);
    this.draftTimers.forEach((timer: number) => clearTimeout(timer));
    this.draftTimers.clear();
    this.pollTimer = -1;

  }

  async refresh(): Promise<void> {
    const generation = this.authEpoch; const read = ++this.catalogReadEpoch;
    const attachmentsRead = this.uploading ? -1 : ++this.attachmentRead;
    const selectedId = this.selected?.session_id;
    const data = JSON.parse(await this.api.request('/api/sessions')) as Catalog;
    if (generation !== this.authEpoch || read !== this.catalogReadEpoch) return;
    this.sessions = data.sessions;
    this.recentCwds = data.recent_cwds || [];
    this.tmuxAvailable = data.tmux_available;
    if (data.new_session_defaults) this.launchDefaults = data.new_session_defaults;
    if (this.selected && this.selected.session_id === selectedId) {
      const session = data.sessions.find((row: Session) => row.session_id === this.selected?.session_id);
      if (session) {
        this.selected = session;
        // The server's staged list is authoritative, including an upload whose
        // reply was lost. Older reads cannot replace a newer mutation result.
        if (attachmentsRead === this.attachmentRead && Array.isArray(session.staged_attachments)) this.attachments = session.staged_attachments || [];
        const activity = this.activity.clone(); activity.snapshot(session); this.activity = activity;
        this.busy = !!session.busy;
        if (!session.orphan_recovery && (session.draft_updated_ts || 0) > (this.draftStamps.get(session.session_id) || 0) &&
          this.draft === this.draftBaselines.get(session.session_id)) {
          await this.reconcileDraft(session.session_id);
          if (generation !== this.authEpoch || read !== this.catalogReadEpoch) return;
        }
      } else this.clearRemovedSession();
    }
    const launch = this.pendingLaunch;
    if (launch) {
      if (this.pendingLaunchEpoch !== this.epoch) { this.pendingLaunch = undefined; return; }
      const created = this.sessions.find((row: Session) =>
        (!!launch.session_id && row.session_id === launch.session_id) ||
        (!!launch.broker_pid && row.broker_pid === launch.broker_pid) ||
        (!!launch.launch_id && row.launch_id === launch.launch_id));
      if (created && !launchPending(created)) {
        this.pendingLaunch = undefined;
        if (launchFailed(created)) { this.error = created.launch_error || 'Session launch failed.'; this.sidebar = true; }
        else {
          const name = this.pendingLaunchName; this.pendingLaunchName = '';
          if (name && name !== created.alias) {
            try {
              const body: NameRequest = { name: name };
              await this.api.request(this.path('rename', created.session_id), http.RequestMethod.POST, JSON.stringify(body));
              if (generation !== this.authEpoch || this.pendingLaunchEpoch !== this.epoch) return;
              created.alias = name;
            } catch (reason) { if (generation === this.authEpoch) this.error = 'Session started, but its name could not be saved: ' + (reason as Error).message; }
          }
          if (generation === this.authEpoch && this.pendingLaunchEpoch === this.epoch) await this.select(created);
        }
      }
    }
  }

  private clearRemovedSession(): void {
    if (!this.selected) return;
    this.drafts.set(this.selected.session_id, this.draft);
    this.stashFile(); this.sessionFiles.set(this.selected.session_id, this.fileTabs);
    this.epoch++; this.fileEpoch++;
    this.closeStream?.(); this.closeStream = undefined; this.streamActive = false;
    this.selected = undefined; this.events = []; this.queue = []; this.queueChanging = false;
    this.attachments = []; this.draft = ''; this.sending = false; this.settingBusy = false; this.uploading = false;
    this.activeFile = undefined; this.fileTabs = []; this.fileText = ''; this.fileDirty = false; this.localMedia = '';
    this.files = []; this.gitFiles = []; this.gitDiff = ''; this.details = ''; this.clearSearch();
    this.activity = new Activity(); this.busy = false; this.liveCursor = ''; this.historyCursor = ''; this.transcriptBinding = '';
    this.hasOlder = false; this.browsingHistory = false; this.panel = ''; this.sidebar = true;
    this.error = ''; this.connectionStatus = ''; this.notice = 'This session is no longer available. Local drafts are preserved.';
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.authenticated) return;
    this.polling = true;
    const token = this.epoch;
    const sessionId = this.selected?.session_id;
    try {
      await this.refresh();
      this.draftPending.forEach((_text: string, id: string) => {
        if (!this.draftTimers.has(id) && this.sessions.some((row: Session) => row.session_id === id && !row.orphan_recovery)) this.flushDraft(id);
      });
      if (sessionId && token === this.epoch && this.panel === 'queue' && !this.queueChanging) await this.loadQueue();
      if (sessionId && token === this.epoch && !this.streamActive && !this.selected?.orphan_recovery) {
        const suffix = this.liveCursor ? 'messages/live?cursor=' + encodeURIComponent(this.liveCursor) : 'messages/tail?limit=80';
        const data = JSON.parse(await this.api.request(this.path(suffix, sessionId))) as Transcript;
        if (token === this.epoch) {
          this.acceptTranscript(data, !this.liveCursor);
          this.connectStream();
        }
      }
      if (token === this.epoch) this.connectionStatus = '';
    } catch (reason) {
      if (token === this.epoch) {
        if (!(reason as ApiError).status || (reason as ApiError).status >= 500) this.connectionStatus = 'Reconnecting… Your draft is kept on this device.';
        else if ((reason as ApiError).status === 409) { this.liveCursor = ''; }
        else this.error = (reason as Error).message;
      }
    } finally { this.polling = false; }
  }

  private connectStream(): void {
    if (this.closeStream || !this.liveCursor || !this.selected) return;
    const token = this.epoch;
    this.streamActive = true;
    this.closeStream = this.api.stream(this.path('live?cursor=' + encodeURIComponent(this.liveCursor)),
      (event: string, raw: string) => {
        if (token !== this.epoch || event !== 'message') return;
        try { const data = JSON.parse(raw) as Transcript; this.acceptTranscript(data); }
        catch (_) { this.error = 'Unable to read stream update.'; }
      }, () => { if (token === this.epoch) { this.streamActive = false; this.closeStream = undefined; } });
  }

  private acceptTranscript(data: Transcript, replace: boolean = false): void {
    const binding = (data.transcript_state || '') + ':' + (data.thread_id || '') + ':' + (data.log_path || '');
    // Keep the last readable transcript while the server discovers a new log.
    if (data.transcript_state === 'pending_bind' && this.events.length) {
      this.applyRuntime(data, false);
      return;
    }
    const changed = this.transcriptBinding !== '' && this.transcriptBinding !== binding;
    const activity = changed || data.reset ? new Activity() : this.activity.clone();
    activity.live(data, !changed && !!data.live_cursor && data.live_cursor === this.liveCursor);
    this.activity = activity;
    if (this.browsingHistory && !replace && !data.reset && !changed) { this.applyRuntime(data, false); return; }
    if (replace || data.reset || changed) {
      this.historyRequest++;
      this.browsingHistory = false;
      this.events = data.events || [];
      this.historyCursor = '';
      this.hasOlder = false;
    } else this.merge(data.events || []);
    this.transcriptBinding = binding;
    this.applyRuntime(data);
    this.onTranscriptChanged(replace || !!data.reset || changed);
  }

  private applyRuntime(data: Transcript, history: boolean = true): void {
    if (data.live_cursor !== undefined) this.liveCursor = data.live_cursor || '';
    if (data.busy !== undefined) this.busy = this.activity.turnOpen || data.busy;
    if (history && data.history_cursor !== undefined) this.historyCursor = data.history_cursor || '';
    if (history && data.has_older !== undefined) this.hasOlder = data.has_older;
  }

  private merge(incoming: ChatEvent[]): void {
    const result = this.events.slice();
    incoming.forEach((event: ChatEvent) => {
      const index = result.findIndex((existing: ChatEvent) => eventKey(existing) === eventKey(event));
      if (index < 0) result.push(event);
      else result[index] = event;
    });
    this.events = result;
  }

  async select(session: Session): Promise<void> {
    if (this.selected) this.drafts.set(this.selected.session_id, this.draft);
    this.closeStream?.(); this.closeStream = undefined; this.streamActive = false;
    const token = ++this.epoch;
    this.uploading = this.pendingUploads.has(session.session_id);
    if (this.selected) { this.stashFile(); this.sessionFiles.set(this.selected.session_id, this.fileTabs); }
    this.selected = session;
    this.activity = new Activity(); this.activity.snapshot(session);
    this.sidebar = false;
    this.panel = '';
    this.events = [];
    this.queue = []; this.queueChanging = false; this.attachments = []; this.clearSearch(); this.files = [];
    this.fileTabs = this.sessionFiles.get(session.session_id) || []; this.activeFile = undefined; this.fileText = ''; this.fileDirty = false; this.localMedia = '';
    this.browsingHistory = false; this.hasOlder = false; this.busy = !!session.busy;
    this.liveCursor = '';
    this.historyCursor = '';
    this.transcriptBinding = '';
    this.error = '';
    this.restoreDraft(session.session_id);
    this.draft = this.drafts.get(session.session_id) || '';
    if (session.orphan_recovery) { this.error = 'Original session unavailable. Open Queue to review preserved prompts.'; return; }
    try {
      const data = JSON.parse(await this.api.request(this.path('messages/tail?limit=80', session.session_id))) as Transcript;
      if (token !== this.epoch) return;
      this.acceptTranscript(data, true);
      await this.reconcileDraft(session.session_id);
      if (token !== this.epoch) return;
      this.connectStream();
      await this.loadAttachments();
      await this.api.request(this.path('read', session.session_id), http.RequestMethod.POST, '{}');
    } catch (reason) { if (token === this.epoch) this.error = (reason as Error).message; }
  }

  private draftPath(id: string): string {
    return this.storageDir + '/draft-' + this.endpointKey + '-' + encodeURIComponent(id) + '.txt';
  }

  private restoreDraft(id: string): void {
    if (!this.storageDir || this.drafts.has(id)) return;
    try { this.drafts.set(id, fs.readTextSync(this.draftPath(id))); } catch (_) {}
    try {
      const baseline = JSON.parse(fs.readTextSync(this.draftPath(id) + '.sync')) as DraftResponse;
      if (typeof baseline.text === 'string' && typeof baseline.updated_ts === 'number' && baseline.updated_ts >= 0) {
        this.draftStamps.set(id, baseline.updated_ts); this.draftBaselines.set(id, baseline.text);
      }
    } catch (_) {}
    try { if (fs.readTextSync(this.sendStatePath(id)) === 'pending') this.pendingSends.add(id); } catch (_) {}
  }

  private sendStatePath(id: string): string { return this.storageDir + '/send-' + this.endpointKey + '-' + encodeURIComponent(id) + '.txt'; }
  private persistSend(path: string, pending: boolean): void {
    if (path) {
      const file = fs.openSync(path + '.tmp', fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      try { fs.writeSync(file.fd, pending ? 'pending' : 'confirmed'); } finally { fs.closeSync(file); }
      fs.renameSync(path + '.tmp', path);
    }
  }
  private rememberSend(id: string, pending: boolean): void {
    this.persistSend(this.storageDir ? this.sendStatePath(id) : '', pending);
    if (pending) this.pendingSends.add(id); else this.pendingSends.delete(id);
  }

  private rememberDraft(id: string, text: string): void {
    this.drafts.set(id, text);
    this.draftRevisions.set(id, (this.draftRevisions.get(id) || 0) + 1);
    if (!this.storageDir) return;
    try {
      const file = fs.openSync(this.draftPath(id) + '.tmp', fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      try { fs.writeSync(file.fd, text); } finally { fs.closeSync(file); }
      fs.renameSync(this.draftPath(id) + '.tmp', this.draftPath(id));
    } catch (_) { this.error = 'Unable to save the draft on this device.'; }
  }

  setDraft(text: string): void {
    // TextArea can echo a programmatic value through onChange. Restoring or
    // pulling a draft is not a new local edit and must not push it back.
    if (text === this.draft) return;
    this.draft = text;
    const id = this.selected?.session_id;
    if (!id) return;
    this.rememberDraft(id, text);
    this.syncDraft(id, text);
  }

  // The server timestamp is authoritative. A positive empty record is a
  // deletion; timestamp zero means no server entry, never a remote deletion.
  private acknowledgeDraft(id: string, text: string, stamp: number): void {
    this.draftStamps.set(id, stamp); this.draftBaselines.set(id, text);
    if (!this.storageDir) return;
    try {
      const path = this.draftPath(id) + '.sync';
      const body: DraftResponse = { text: text, updated_ts: stamp };
      const file = fs.openSync(path + '.tmp', fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      try { fs.writeSync(file.fd, JSON.stringify(body)); } finally { fs.closeSync(file); }
      fs.renameSync(path + '.tmp', path);
    } catch (_) { this.error = 'Unable to save draft synchronization state on this device.'; }
  }

  private async reconcileDraft(id: string): Promise<void> {
    if (this.draftPending.has(id) || this.draftWrites.has(id)) return;
    const generation = this.authEpoch; const token = this.epoch;
    const revision = this.draftRevisions.get(id) || 0;
    const response = JSON.parse(await this.api.request(this.path('draft', id))) as DraftResponse;
    if (generation !== this.authEpoch || token !== this.epoch || this.selected?.session_id !== id ||
      revision !== (this.draftRevisions.get(id) || 0) || this.draftPending.has(id) || this.draftWrites.has(id)) return;
    const text = response.text || ''; const stamp = response.updated_ts || 0;
    const previous = this.draftStamps.get(id) || 0;
    const local = this.drafts.get(id) || '';
    if (stamp > previous) {
      this.rememberDraft(id, text); this.draft = text;
      this.acknowledgeDraft(id, text, stamp);
    } else if (stamp === 0 && local) {
      this.syncDraft(id, local);
    } else if (stamp === previous && local !== text) {
      this.syncDraft(id, local);
    } else if (stamp === 0 || stamp === previous) {
      this.acknowledgeDraft(id, text, stamp);
    }
  }

  private syncDraft(id: string, text: string): void {
    if (this.selected?.session_id === id && this.selected.orphan_recovery) return;
    this.draftPending.set(id, text);
    const timer = this.draftTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.draftTimers.set(id, setTimeout(() => {
      this.draftTimers.delete(id); this.flushDraft(id);
    }, 600));
  }

  private flushDraft(id: string): void {
    if (!this.draftPending.has(id) || this.draftWrites.has(id)) return;
    const generation = this.authEpoch;
    const text = this.draftPending.get(id) || '';
    const revision = this.draftRevisions.get(id) || 0;
    const body: TextRequest = { text: text };
    const write = this.api.request(this.path('draft', id), http.RequestMethod.POST, JSON.stringify(body)).then((raw: string) => {
      if (generation !== this.authEpoch) return;
      const response = JSON.parse(raw) as DraftResponse;
      this.acknowledgeDraft(id, text, response.updated_ts || 0);
      if (revision === (this.draftRevisions.get(id) || 0)) this.draftPending.delete(id);
    }).catch((reason: Error) => {
      if (generation === this.authEpoch && this.selected?.session_id === id) this.error = 'Draft sync: ' + reason.message;
    }).finally(() => {
      if (generation !== this.authEpoch) return;
      this.draftWrites.delete(id);
      // New typing during a write follows it; a failed write waits for the
      // regular reconnect poll instead of creating an immediate retry loop.
      if (this.draftPending.has(id) && revision !== (this.draftRevisions.get(id) || 0) && !this.draftTimers.has(id)) {
        this.syncDraft(id, this.draftPending.get(id) || '');
      }
    });
    this.draftWrites.set(id, write);
  }

  unknownSend(): boolean {
    return !!this.selected?.commit_unknown_send || this.pendingSends.has(this.selected?.session_id || '');
  }

  async clearUnknownSend(): Promise<void> {
    const id = this.selected?.session_id;
    if (!id) return;
    await this.action('commit_unknown_send/clear', '{}', id);
    this.rememberSend(id, false);
    this.error = '';
  }

  async send(enqueue: boolean = false, allowPendingAttachment: boolean = false): Promise<void> {
    const id = this.selected?.session_id;
    const text = this.draft;
    if (!id || !text.trim() || this.sending) return;
    if (this.uploading) { this.error = 'Wait for the attachment upload to finish.'; return; }
    if (enqueue && (this.attachments.length > 0 || this.selected?.pending_attachment)) {
      this.error = 'Send or remove the pending attachment before adding a message to the queue.'; return;
    }
    if (!enqueue && this.needsAttachmentConfirmation() && !allowPendingAttachment) {
      this.error = 'Confirm sending with the pending attachment.'; return;
    }
    if (this.selected?.orphan_recovery || this.selected?.queue_recovery) {
      this.error = this.selected.orphan_recovery ? 'Missing session can only be reviewed.' : 'Review the preserved queue before sending.';
      return;
    }
    if (this.selected?.commit_unknown_send || this.pendingSends.has(id)) {
      this.error = 'The last send has an unknown outcome. Check the transcript before clearing it.';
      return;
    }
    this.sending = true;
    this.error = '';
    const generation = this.authEpoch;
    const token = this.epoch;
    const sendState = this.storageDir ? this.sendStatePath(id) : '';
    let accepted = false;
    const body: SendRequest = { text: text, allow_pending_attachment: !enqueue && (this.attachments.length > 0 || allowPendingAttachment) };
    try {
      this.rememberSend(id, true);
      const result = JSON.parse(await this.api.request(this.path(enqueue ? 'enqueue' : 'send', id), http.RequestMethod.POST, JSON.stringify(body))) as SendResult;
      accepted = true;
      if (generation !== this.authEpoch) return;
      this.rememberSend(id, false);
      if (this.drafts.get(id) === text) { this.rememberDraft(id, ''); this.syncDraft(id, ''); }
      if (this.selected?.session_id === id && this.draft === text) this.draft = '';
      if (token !== this.epoch) return;
      this.notice = result.commit_unknown ? 'Send status unknown; queued item needs review.' : result.queued ? 'Queued' : 'Sent';
      await this.loadAttachments();
      await this.poll();
      if (enqueue) await this.loadQueue();
    } catch (reason) {
      const failure = reason as ApiError;
      // A failed follow-up read cannot undo the server's accepted send or make
      // it uncertain. Keep submission state separate from refreshing the view.
      if (accepted) {
        if (generation === this.authEpoch && token === this.epoch) this.error = 'Message accepted, but refreshing failed: ' + failure.message;
        return;
      }
      if (generation !== this.authEpoch) {
        if (failure.status && failure.status !== 499) this.persistSend(sendState, false);
        return;
      }
      if (failure.status) this.rememberSend(id, false);
      else this.pendingSends.add(id);
      if (token !== this.epoch) return;
      this.error = failure.status ? failure.message : 'Send outcome unknown. Check the transcript before retrying. Your message is preserved.';
      await this.refresh().catch(() => {});
    } finally { if (generation === this.authEpoch) this.sending = false; }
  }

  needsAttachmentConfirmation(): boolean { return !!this.selected?.pending_attachment && this.attachments.length === 0; }

  async chooseCommand(choice: ComposerChoice): Promise<void> {
    if (choice.kind === 'command') { this.setDraft('/' + choice.value + ' '); return; }
    if (this.selected?.agent_backend === 'codex') {
      const draft = this.draft; const id = this.selected.session_id;
      const body: Record<string, string> = {}; body[choice.kind] = choice.value;
      await this.action('settings', JSON.stringify(body), id);
      if (this.selected?.session_id === id && this.draft === draft) this.setDraft('');
      this.notice = 'Setting accepted for the next turn';
    } else { this.setDraft('/' + choice.kind + ' ' + choice.value); await this.send(); }
  }

  async changeSessionSetting(kind: string, value: string): Promise<void> {
    const session = this.selected;
    const token = this.epoch;
    const generation = this.authEpoch;
    if (!session || this.settingBusy) return;
    if (!['model', 'effort'].includes(kind) || !value.trim() || /[\r\n]/.test(value)) throw new Error('Choose a valid setting.');
    if (!supports(session, kind)) throw new Error('This session does not support live changes.');
    if (session.agent_backend !== 'codex' && (this.sending || session.pending_attachment || this.attachments.length || this.pendingSends.has(session.session_id))) {
      throw new Error('Finish the pending message or attachment before changing this setting.');
    }
    this.settingBusy = true;
    try {
      if (session.agent_backend === 'codex') {
        const body: Record<string, string> = {}; body[kind] = value.trim();
        await this.api.request(this.path('settings', session.session_id), http.RequestMethod.POST, JSON.stringify(body));
      } else {
        const body: SendRequest = { text: '/' + kind + ' ' + value.trim(), allow_pending_attachment: false };
        const result = JSON.parse(await this.api.request(this.path('send', session.session_id), http.RequestMethod.POST, JSON.stringify(body))) as SendResult;
        if (result.commit_unknown) throw new Error('Change status unknown. Check the session before trying again.');
      }
      if (generation !== this.authEpoch || token !== this.epoch) return;
      this.notice = session.agent_backend === 'codex' ? 'Setting accepted for the next turn' : 'Setting command sent';
      // The server's log still describes the previous turn until the next turn.
      // Do not overwrite current settings or any unsent composer draft.
    } finally { if (generation === this.authEpoch) this.settingBusy = false; }
  }

  async older(): Promise<void> {
    if (!this.historyCursor) return;
    const token = this.epoch;
    const request = ++this.historyRequest;
    const data = JSON.parse(await this.api.request(this.path('messages/history?cursor=' + encodeURIComponent(this.historyCursor) + '&limit=80'))) as Transcript;
    if (token !== this.epoch || request !== this.historyRequest) return;
    const ids = new Set(this.events.map((event: ChatEvent) => eventKey(event)));
    this.events = (data.events || []).filter((event: ChatEvent) => !ids.has(eventKey(event))).concat(this.events);
    this.historyCursor = data.history_cursor || '';
    this.hasOlder = data.has_older || false;
  }

  async action(action: string, body: string = '{}', id?: string): Promise<void> {
    const generation = this.authEpoch;
    await this.api.request(this.path(action, id), http.RequestMethod.POST, body);
    if (generation === this.authEpoch) await this.refresh();
  }

  async create(request: CreateSession): Promise<void> {
    if (this.creating) return;
    if (!request.cwd.trim()) throw new Error('Enter a working directory.');
    const token = this.epoch;
    const generation = this.authEpoch;
    this.creating = true;
    try {
      const result = JSON.parse(await this.api.request('/api/sessions', http.RequestMethod.POST, JSON.stringify(request))) as CreateResponse;
      if (token !== this.epoch || generation !== this.authEpoch) return;
      this.pendingLaunchName = request.name?.trim() || '';
      this.pendingLaunch = result; this.pendingLaunchEpoch = token;
      this.panel = ''; this.sidebar = true;
      this.notice = result.pending ? 'Session is still starting.' : 'Session started. Waiting for its conversation log.';
      await this.refresh();
    } catch (reason) {
      if (generation === this.authEpoch) await this.refresh().catch(() => {});
      throw reason as Error;
    } finally { if (generation === this.authEpoch) this.creating = false; }
  }

  async rename(session: Session, name: string): Promise<void> {
    const body: NameRequest = { name: name };
    await this.action('rename', JSON.stringify(body), session.session_id);
  }

  async loadQueue(): Promise<void> {
    const token = this.epoch; const read = ++this.queueReadEpoch;
    const data = JSON.parse(await this.api.request(this.path('queue'))) as QueueResponse;
    if (token === this.epoch && read === this.queueReadEpoch) this.queue = data.items || [];
  }

  queueLocked(item: QueueItem): boolean { return !!(item.sending || item.commit_unknown || item.orphan_recovery); }
  queueCanMove(index: number, target: number): boolean {
    if (target < 0 || target >= this.queue.length || !this.queue[index]) return false;
    for (let i = Math.min(index, target); i <= Math.max(index, target); i++) if (this.queueLocked(this.queue[i])) return false;
    return true;
  }
  async changeQueue(action: string, body: QueueMutation): Promise<void> {
    if (this.queueChanging) throw new Error('Wait for the current queue change to finish.');
    const index = this.queue.findIndex((item: QueueItem) => item.id === body.id);
    const item = this.queue[index];
    if (!item) throw new Error('Queue changed. Refresh and try again.');
    if (item.sending) throw new Error('This message is being sent.');
    if (action !== 'delete' && this.queueLocked(item)) throw new Error('Review this recovery item before changing the queue.');
    if (action === 'move' && !this.queueCanMove(index, body.to_index ?? -1)) throw new Error('Cannot move across a sending or recovery item.');
    if (action === 'delete' && ((item.commit_unknown && !body.allow_commit_unknown) || (item.orphan_recovery && !body.allow_orphan_recovery))) throw new Error('Confirm deletion after reviewing the transcript.');
    const token = this.epoch;
    this.queueChanging = true; this.queueReadEpoch++;
    try {
      await this.action('queue/' + action, JSON.stringify(body));
      if (token === this.epoch) await this.loadQueue();
    } finally { if (token === this.epoch) this.queueChanging = false; }
  }

  clearSearch(): void {
    this.searchEpoch++; this.searchMatches = []; this.searchQuery = ''; this.searchIndex = -1;
    this.searchTotal = 0; this.searchBase = 0; this.searchLoading = false;
  }
  async search(query: string, older: boolean = false): Promise<void> {
    const value = query.trim();
    if (!value) { this.clearSearch(); return; }
    const token = this.epoch; const request = ++this.searchEpoch;
    const first = this.searchMatches[0];
    const before = older && first ? first.history_cursor || first.before_byte || first.cursor || first.load_cursor : '';
    if (!older) { this.searchQuery = value; this.searchMatches = []; this.searchIndex = -1; this.searchTotal = 0; this.searchBase = 0; }
    this.searchLoading = true;
    try {
      const data = JSON.parse(await this.api.request(this.path('search?q=' + encodeURIComponent(value) + '&limit=60&order=latest' + (before ? '&before=' + encodeURIComponent(before) : '')))) as SearchResponse;
      if (token !== this.epoch || request !== this.searchEpoch) return;
      const matches = data.matches || [];
      const count = data.total ?? data.match_count ?? matches.length;
      if (older) {
        const known = new Set(this.searchMatches.map((match: SearchMatch) => JSON.stringify(match)));
        const additional = matches.filter((match: SearchMatch) => !known.has(JSON.stringify(match)));
        this.searchMatches = additional.concat(this.searchMatches);
        this.searchIndex = Math.max(0, additional.length - 1);
        this.searchBase = Math.max(0, count - additional.length);
      } else {
        this.searchMatches = matches; this.searchTotal = count;
        this.searchBase = Math.max(0, count - matches.length); this.searchIndex = matches.length - 1;
      }
    } finally { if (token === this.epoch && request === this.searchEpoch) this.searchLoading = false; }
  }
  async stepSearch(direction: number): Promise<number> {
    if (this.searchLoading || !this.searchMatches.length) return -1;
    const token = this.epoch;
    const query = this.searchQuery;
    if (direction < 0 && this.searchIndex <= 0 && this.searchBase > 0) {
      await this.search(query, true);
      if (token !== this.epoch || query !== this.searchQuery) return -1;
    } else this.searchIndex = (this.searchIndex + direction + this.searchMatches.length) % this.searchMatches.length;
    const match = this.searchMatches[this.searchIndex];
    return match ? this.jump(match) : -1;
  }

  async jump(match: SearchMatch): Promise<number> {
    const found = this.searchMatches.indexOf(match); if (found >= 0) this.searchIndex = found;
    const token = this.epoch;
    const cursor = match.history_cursor || match.before_byte || match.cursor || match.load_cursor;
    if (!cursor) return -1;
    const request = ++this.historyRequest;
    const data = JSON.parse(await this.api.request(this.path('messages/window?cursor=' + encodeURIComponent(cursor) + '&before=30&after=30'))) as Transcript;
    if (token !== this.epoch || request !== this.historyRequest) return -1;
    this.events = data.events;
    this.browsingHistory = true;
    this.applyRuntime(data);
    this.panel = '';
    return this.events.findIndex((event: ChatEvent) => (!!match.message_id && event.message_id === match.message_id) || (!!cursor && event.history_cursor === cursor));
  }

  async navigateUser(start: number, direction: number): Promise<number> {
    for (let i = start + direction; i >= 0 && i < this.events.length; i += direction) {
      if (this.events[i].role === 'user') return i;
    }
    const users = this.events.filter((event: ChatEvent) => event.role === 'user');
    const anchor = direction < 0 ? users[0] : users[users.length - 1];
    if (!anchor?.history_cursor) { this.notice = 'No user message available'; return -1; }
    const token = this.epoch;
    const data = JSON.parse(await this.api.request(this.path('messages/neighbor?role=user&direction=' + (direction < 0 ? 'previous' : 'next') + '&cursor=' + encodeURIComponent(anchor.history_cursor)))) as NeighborResponse;
    if (token !== this.epoch) return -1;
    if (!data.neighbor) { this.notice = direction < 0 ? 'At first user message' : 'At last user message'; return -1; }
    return this.jump(data.neighbor);
  }

  async latest(): Promise<void> {
    const token = this.epoch;
    const request = ++this.historyRequest;
    const data = JSON.parse(await this.api.request(this.path('messages/tail?limit=80'))) as Transcript;
    if (token === this.epoch && request === this.historyRequest) this.acceptTranscript(data, true);
  }

  async loadFiles(query: string = ''): Promise<void> {
    this.refreshRecovery();
    const token = this.epoch; const request = ++this.fileEpoch;
    const suffix = query ? 'file/search?q=' + encodeURIComponent(query) + '&limit=120' : 'file/list';
    const data = JSON.parse(await this.api.request(this.path(suffix))) as FileListing;
    if (token !== this.epoch || request !== this.fileEpoch) return;
    this.files = data.matches || data.entries || (data.files || []).map((path: string): FileEntry => { return { path: path }; });
  }

  async loadGit(): Promise<void> {
    const token = this.epoch;
    const data = JSON.parse(await this.api.request(this.path('git/changed_files'))) as GitChanges;
    if (token === this.epoch) { this.gitFiles = data.entries || []; this.gitFiles.forEach((entry: GitEntry) => { entry.path_token = entry.path_token || entry.api_path; }); this.panel = 'git'; }
  }
  async openDiff(file: GitEntry): Promise<void> {
    const token = this.epoch;
    const query = '?head=1&path=' + encodeURIComponent(file.path) + (file.path_token ? '&path_token=' + encodeURIComponent(file.path_token) : '');
    const data = JSON.parse(await this.api.request(this.path('git/diff' + query))) as GitDiff;
    if (token === this.epoch) { this.gitPath = file.path; this.gitDiff = data.diff; this.panel = 'diff'; }
  }

  refreshRecovery(): void {
    try { this.recoveryFiles = this.fileDrafts.list(this.storageDir, this.endpointKey, this.selected?.session_id || ''); }
    catch (_) { this.error = 'Saved file drafts could not be read.'; }
  }
  recoverFile(draft: FileDraft): void {
    if (!this.authenticated || draft.server !== this.endpointKey || draft.session !== this.selected?.session_id) return;
    this.stashFile();
    // Read the newest persisted buffer: the recovery list may predate another edit.
    const current = this.fileDrafts.get(this.storageDir, draft.server, draft.session, draft.key);
    if (!current) { this.refreshRecovery(); return; }
    this.fileEpoch++;
    this.activeFile = current.base; this.fileText = current.text;
    this.fileDirty = current.text !== (current.base.text || '');
    this.localMedia = ''; this.fileLocation = ''; this.panel = 'file';
    this.stashFile(); this.notice = 'Restored unsaved file changes from this device.';
  }
  fileViewState(): FileViewState {
    const key = this.historyKey();
    let state = this.fileViews.get(key);
    if (!state) { state = new FileViewState(); this.fileViews.set(key, state); }
    return state;
  }
  fileKey(file: FileContent): string { return file.path_token || file.api_path || file.rel || file.path; }
  private persistFile(file: FileContent, text: string, dirty: boolean, session: string = this.selected?.session_id || ''): void {
    if (!file.editable) return;
    try { this.fileDrafts.put(this.storageDir, { server: this.endpointKey, session: session, key: this.fileKey(file), base: file, text: text }, dirty); }
    catch (_) { this.error = 'Your changes are open, but could not be saved on this device. Save or copy them before closing the app.'; }
  }
  changeFile(text: string, record: boolean = true, typing: boolean = false): void {
    if (!this.activeFile?.editable) return;
    if (record) this.fileHistory().change(text, typing);
    this.fileText = text; this.fileDirty = text !== (this.activeFile.text || '');
    this.persistFile(this.activeFile, text, this.fileDirty);
  }
  private historyKey(): string { return (this.selected?.session_id || '') + '\n' + (this.activeFile ? this.fileKey(this.activeFile) : ''); }
  fileHistory(): EditHistory {
    const key = this.historyKey();
    let history = this.fileHistories.get(key);
    if (!history) { history = new EditHistory(); history.reset(this.fileText); this.fileHistories.set(key, history); }
    return history;
  }
  stashFile(): void {
    if (!this.activeFile) return;
    const current: FileTab = { key: this.fileKey(this.activeFile), content: this.activeFile, text: this.fileText, dirty: this.fileDirty, media: this.localMedia };
    this.persistFile(current.content, current.text, current.dirty);
    const index = this.fileTabs.findIndex((tab: FileTab) => tab.key === current.key);
    this.fileTabs = index < 0 ? this.fileTabs.concat([current]) : this.fileTabs.map((tab: FileTab) => tab.key === current.key ? current : tab);
  }
  switchFile(key: string): void {
    this.stashFile();
    const tab = this.fileTabs.find((item: FileTab) => item.key === key);
    if (!tab) return;
    this.fileEpoch++;
    this.activeFile = tab.content; this.fileText = tab.text; this.fileDirty = tab.dirty; this.localMedia = tab.media; this.fileLocation = ''; this.panel = 'file';
  }
  discardFile(): void {
    this.fileText = this.activeFile?.text || ''; this.fileHistory().reset(this.fileText); this.fileDirty = false; this.stashFile();
  }
  closeFile(key: string): void {
    this.stashFile();
    const index = this.fileTabs.findIndex((tab: FileTab) => tab.key === key);
    if (index < 0) return;
    this.persistFile(this.fileTabs[index].content, '', false);
    const active = this.activeFile && this.fileKey(this.activeFile) === key;
    this.fileHistories.delete((this.selected?.session_id || '') + '\n' + key);
    this.fileViews.delete((this.selected?.session_id || '') + '\n' + key);
    this.fileTabs = this.fileTabs.filter((tab: FileTab) => tab.key !== key);
    if (active) {
      this.fileEpoch++; this.activeFile = undefined; this.fileText = ''; this.fileDirty = false; this.localMedia = '';
      if (this.fileTabs.length) this.switchFile(this.fileTabs[Math.min(index, this.fileTabs.length - 1)].key);
      else this.panel = 'files';
    }
  }
  async reloadFile(): Promise<void> {
    const file = this.activeFile; if (!file) return;
    const previousText = this.fileText;
    const token = this.epoch; const request = ++this.fileEpoch;
    const content = JSON.parse(await this.api.request(this.path('file/read?path=' + encodeURIComponent(file.rel || file.path) + (file.path_token ? '&path_token=' + encodeURIComponent(file.path_token) : '')))) as FileContent;
    if (token !== this.epoch || request !== this.fileEpoch) return;
    if (this.fileText !== previousText) throw new Error('The file changed while reloading. Your edits are kept.');
    content.path_token = content.path_token || content.api_path;
    this.activeFile = content; this.fileText = content.text || ''; this.fileHistory().reset(this.fileText); this.fileDirty = false; this.stashFile(); this.notice = 'Reloaded';
  }
  async openFileReference(path: string, location: string = '', onDirectory: (path: string) => void = () => {}, apiPath: string = ''): Promise<void> {
    const token = this.epoch;
    const id = this.selected?.session_id || '';
    if (!id) return;
    const body: FileReferenceRequest = { session_id: id, path: path, path_token: apiPath || undefined };
    const entry = JSON.parse(await this.api.request('/api/files/inspect', http.RequestMethod.POST, JSON.stringify(body))) as FileEntry;
    if (token !== this.epoch || this.selected?.session_id !== id) return;
    if (entry.kind === 'directory') { onDirectory(entry.path); return; }
    await this.openFile(entry, location);
  }
  async openFile(entry: FileEntry, location: string = ''): Promise<void> {
    this.stashFile();
    const cached = this.fileTabs.find((tab: FileTab) => tab.key === (entry.path_token || entry.api_path || entry.path) || (!entry.path_token && !entry.api_path && (tab.content.rel === entry.path || tab.content.path === entry.path)));
    if (cached && (['text', 'markdown', 'download_only'].includes(cached.content.kind) || cached.media)) { this.switchFile(cached.key); this.fileLocation = location; return; }
    const token = this.epoch; const request = ++this.fileEpoch;
    const query = '?path=' + encodeURIComponent(entry.path) + ((entry.path_token || entry.api_path) ? '&path_token=' + encodeURIComponent(entry.path_token || entry.api_path || '') : '');
    this.localMedia = '';
    const content = JSON.parse(await this.api.request(this.path('file/read' + query))) as FileContent;
    if (token !== this.epoch || request !== this.fileEpoch) return;
    content.path_token = content.path_token || content.api_path;
    this.activeFile = content;
    this.fileLocation = location;
    this.fileText = this.activeFile.text || '';
    this.fileDirty = false;
    if (content.editable) {
      try {
        const draft = this.fileDrafts.get(this.storageDir, this.endpointKey, this.selected?.session_id || '', this.fileKey(content));
        if (draft && draft.text !== this.fileText) {
          this.activeFile = draft.base; this.fileText = draft.text; this.fileDirty = true;
          this.notice = 'Restored unsaved file changes from this device.';
        }
      } catch (_) { this.error = 'Saved file drafts could not be read.'; }
    }
    this.panel = 'file';
    this.stashFile();
    const url = this.activeFile.image_url || this.activeFile.pdf_url || this.activeFile.video_url;
    if (url && this.cacheDir) {
      const bytes = await this.api.binary(url);
      if (token !== this.epoch || request !== this.fileEpoch) return;
      const path = this.cacheDir + '/preview-' + Date.now() + (this.activeFile.kind === 'pdf' ? '.pdf' : this.activeFile.kind === 'video' ? '.mp4' : '.image');
      const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      try { fs.writeSync(file.fd, bytes); } finally { fs.closeSync(file); }
      this.localMedia = path; this.stashFile();
    }
  }

  fileDownloadPath(): string {
    const file = this.activeFile;
    if (!file) throw new Error('Open a file first.');
    return this.path('file/download?path=' + encodeURIComponent(file.rel || file.path) + (file.path_token ? '&path_token=' + encodeURIComponent(file.path_token) : ''));
  }
  async createFile(path: string): Promise<void> {
    const token = this.epoch;
    const request: FileWrite = { path: path.trim(), text: '', create: true };
    if (!request.path) throw new Error('Enter a file path.');
    await this.api.request(this.path('file/write'), http.RequestMethod.POST, JSON.stringify(request));
    if (token === this.epoch) await this.openFile({ path: request.path });
  }
  async saveFile(): Promise<void> {
    const generation = this.authEpoch;
    const file = this.activeFile;
    if (!file || !file.editable) return;
    const text = this.fileText;
    const id = this.selected?.session_id;
    const request: FileWrite = { path: file.rel, text: text, version: file.version, path_token: file.path_token };
    const saved = JSON.parse(await this.api.request(this.path('file/write', id), http.RequestMethod.POST, JSON.stringify(request))) as FileContent;
    if (generation !== this.authEpoch) return;
    file.version = saved.version; file.text = text;
    if (this.activeFile === file && this.selected?.session_id === id) {
      this.fileDirty = this.fileText !== text; this.stashFile(); this.notice = 'Saved';
    } else {
      const tabs = this.selected?.session_id === id ? this.fileTabs : this.sessionFiles.get(id || '') || [];
      const updated = tabs.map((tab: FileTab): FileTab => tab.content === file ? { key: tab.key, content: file, text: tab.text, dirty: tab.text !== text, media: tab.media } : tab);
      if (this.selected?.session_id === id) this.fileTabs = updated;
      else if (id) this.sessionFiles.set(id, updated);
      const tab = updated.find((item: FileTab) => item.content === file);
      this.persistFile(file, tab?.text || text, tab ? tab.dirty : false, id || '');
    }
  }

  async loadAttachments(): Promise<void> {
    const token = this.epoch;
    const read = ++this.attachmentRead;
    const data = JSON.parse(await this.api.request(this.path('attachments'))) as AttachmentsResponse;
    if (token === this.epoch && read === this.attachmentRead) this.attachments = data.attachments || [];
  }

  async upload(uri: string): Promise<void> {
    const id = this.selected?.session_id;
    if (!id || this.pendingUploads.has(id)) return;
    const token = this.epoch;
    const generation = this.authEpoch;
    const current = (): boolean => token === this.epoch && generation === this.authEpoch;
    this.attachmentRead++;
    this.pendingUploads.add(id);
    this.uploading = true;
    try {
      const file = await readAttachment(uri, current);
      if (!current()) return;
      const request: UploadRequest = { filename: file.name, data_b64: new util.Base64Helper().encodeToStringSync(file.bytes) };
      await this.api.request(this.path('inject_file', id), http.RequestMethod.POST, JSON.stringify(request));
      if (current()) await this.loadAttachments();
    } catch (reason) {
      if (!current()) return;
      // A transport failure can follow successful staging. Reconcile without
      // resubmitting; the catalog will retry after a longer network outage.
      try { await this.loadAttachments(); } catch (_) {}
      if (current()) throw reason as Error;
    } finally {
      if (generation === this.authEpoch) {
        this.pendingUploads.delete(id);
        this.uploading = this.pendingUploads.has(this.selected?.session_id || '');
      }
    }
  }

  async removeAttachment(id: string): Promise<void> {
    await this.api.request(this.path('attachments/delete'), http.RequestMethod.POST, JSON.stringify({ id: id } as QueueMutation));
    await this.loadAttachments();
  }

  async loadUnattended(): Promise<void> {
    const token = this.epoch;
    const config = JSON.parse(await this.api.request(this.path('unattended'))) as UnattendedConfig;
    if (token !== this.epoch) return;
    this.unattended = config; this.panel = 'unattended';
  }

  async saveUnattended(config: UnattendedConfig): Promise<void> {
    const token = this.epoch;
    const saved = JSON.parse(await this.api.request(this.path('unattended'), http.RequestMethod.POST, JSON.stringify(config))) as UnattendedConfig;
    if (token !== this.epoch) return;
    this.unattended = saved; this.notice = 'Saved';
    this.panel = '';
  }

  async exportConversation(): Promise<ConversationCopy | undefined> {
    const token = this.epoch;
    const result = JSON.parse(await this.api.request(this.path('messages/export'))) as ExportResponse;
    if (token !== this.epoch) return undefined;
    return conversationCopy(result.events || []);
  }

  async diagnostics(): Promise<void> {
    const token = this.epoch;
    const details = JSON.stringify(JSON.parse(await this.api.request(this.path('diagnostics'))), null, 2);
    if (token !== this.epoch) return;
    this.details = details; this.panel = 'details';
  }
}
