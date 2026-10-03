import { SavedLogin } from '../services/SavedLogin';
import { ApiError } from '../services/ApiClient';
import { ThemeDropdown } from '../components/ui/ThemeDropdown';
import { ToggleTheme } from '../components/ControlTheme';
import { SessionDetails } from '../components/SessionDetails';
import { sessionDiagnostics } from '../model/SessionDetails';
import { Confirmation, ConfirmationOptions } from '../components/Confirmation';
import { SessionStateDot } from '../components/SessionStateDot';
import { HelpContent } from '../components/HelpContent';
import { nativePush } from '../services/NativePush';
import { transcriptDayLabel, startsTranscriptDay, transcriptGap } from '../model/TranscriptPresentation';
import { KeyboardHints, HintBadge, HintBounds } from '../model/KeyboardHints';
import { HintTarget } from '../components/HintTarget';
import { FileDraft } from '../services/FileDrafts';
import { markdownBlocks, InlinePart, measureInlineWidth } from '../model/Markdown';
import { fileLocation, parseFileReferenceLink } from '../model/FileLinks';
import { applyNativeStyle, ComponentStyle, MessageStyles } from '../model/NativeStyle';
import { LaunchContext, ResumeCandidate, DirectoryChoice } from '../model/LaunchContext';
import { sessionCardKey, sessionBackend, sessionLaunchIcon, sessionMetadata, launchPending, launchFailed, sessionBadges, sessionGroup, tomorrowMorning, customSnooze, duplicateRequest } from '../model/SessionPresentation';
import { exportFile } from '../services/FileExport';
import { conversationCopyFailure } from '../model/ConversationCopy';
import { Announcements, VoiceWrite } from '../services/Announcements';
import { contextLabel, subagentText } from '../model/Activity';
import { ComposerChoice, composerChoices } from '../model/ComposerCommands';
import { readPreferences, writePreferences, LaunchChoice, readLaunchChoices, writeLaunchChoices, rememberLaunch } from '../model/Preferences';
import { CodeEditor } from '../components/CodeEditor';
import { PdfReader } from '../components/PdfReader';
import { ImageViewer } from '../components/ImageViewer';
import { VideoViewer } from '../components/VideoViewer';
import { MarkdownView } from '../components/MarkdownView';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { picker } from '@kit.CoreFileKit';
import { display, KeyboardAvoidMode, window, ColorMetrics } from '@kit.ArkUI';
import { drawing } from '@kit.ArkGraphics2D';
import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { Palette, palette, themeVariables } from '../model/Theme';
import { Workspace, FileTab } from '../model/Workspace';
import { Session, ChatEvent, FileEntry, QueueItem, SearchMatch, Attachment, UnattendedConfig, CreateSession, SessionEdit, LaunchDefaults, GitEntry, SubagentDetail, sessionName, eventKey } from '../model/Contracts';

interface NotificationRoute { session: string; server: string; }

@Entry
@Component
struct Index {
  @Provide nativeHints: KeyboardHints = new KeyboardHints();
  @State hintChatClip: HintBounds = { x: 0, y: 0, width: 0, height: 0 };
  private hintViewport: HintBounds = { x: 0, y: 0, width: 400, height: 760 };
  private hintMeta: boolean = false;
  @State announcements: Announcements = new Announcements();
  @State voiceUrl: string = '';
  @State voiceKey: string = '';
  @State voiceClearKey: boolean = false;
  @State voiceNarration: boolean = false;
  @State globalPrompt: string = '';
  @State workspace: Workspace = new Workspace();
  @State server: string = '';
  @State password: string = '';
  @State connecting: boolean = false;
  @State rememberPassword: boolean = true;
  private savedLogin: SavedLogin = new SavedLogin();
  private loginAttempt: number = 0;
  @State viewportWidth: number = 400;
  @State viewportHeight: number = 760;
  @State fileFull: boolean = false;
  @State fileBodyHeight: number = 420;
  @State colors: Palette = palette('clay', false);
  @State themeMode: string = 'system';
  @State customCss: string = '';
  @State cssWarnings: string = '';
  @State messageStyles: MessageStyles = applyNativeStyle('', palette('clay', false), 400).components;
  @StorageLink('system-color-mode') @Watch('systemThemeChanged') systemColorMode: number = -1;
  @StorageLink('notification-route') @Watch('notificationChanged') notificationRoute: string = '';
  private noticeTimer: number = -1;
  @State searchText: string = '';
  @State commandIndex: number = -1;
  @State commandHidden: boolean = false;
  private composingText: boolean = false;
  private composerFocused: boolean = false;
  private composerMeta: boolean = false;
  private chatMeta: boolean = false;
  private chatHeight: number = 450;
  private commandScroller: Scroller = new Scroller();
  @State launchContext: LaunchContext = new LaunchContext();
  @State newName: string = '';
  @State directoryPicker: boolean = false;
  private launchTimer: number = -1;
  @State cwd: string = '';
  @State backend: string = 'pi';
  @State model: string = '';
  @State fast: boolean = false;
  @State priority: number = 0;
  @State snoozeUntil: number | null = null;
  @State snoozeMode: string = 'none';
  @State snoozeDate: string = '';
  @State snoozeTime: string = '';
  @State dependency: string = '';
  @State provider: string = '';
  @State effort: string = '';
  @State resumeId: string = '';
  @State branch: string = '';
  @State tmux: boolean = false;
  @State editText: string = '';
  @State queueEditId: string = '';
  @State autoEnabled: boolean = false;
  @State autoRequest: string = '';
  @State autoCooldown: string = '5';
  @State autoRemaining: string = '10';
  @State foldStatus: number = 0;
  @State editSession: Session | undefined = undefined;
  private launchChoices: LaunchChoice[] = [];
  private visibleMessageIndex: number = 0;
  private navigating: boolean = false;
  @State followingLatest: boolean = true;
  @State chatWidth: number = 357;
  @State copyMessageKey: string = '';
  @State hoverMessageKey: string = '';
  private scrollTimer: number = -1;
  private scroller: Scroller = new Scroller();

  private foldChanged = (status: display.FoldStatus): void => { this.foldStatus = status; };
  aboutToAppear(): void {
    this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
    this.workspace.onTranscriptChanged = (reset: boolean): void => {
      if (reset) this.followingLatest = true;
      this.followTail();
    };
    this.workspace.onAuthenticationLost = (): void => { this.confirmation?.close(); this.announcements.dispose(this.workspace.api); nativePush.revokeLocal().catch(() => { this.workspace.error = 'Login expired; background notification revocation needs a network connection.'; }); this.launchContext.cancel(); };
    this.workspace.storageDir = (getContext(this) as common.UIAbilityContext).filesDir;
    nativePush.initialize(this.workspace.storageDir);
    this.workspace.cacheDir = (getContext(this) as common.UIAbilityContext).cacheDir;
    this.launchChoices = readLaunchChoices(this.workspace.storageDir);
    const stored = readPreferences(this.workspace.storageDir);
    this.server = stored.server; this.themeMode = stored.mode; this.customCss = stored.customCss || '';
    this.applyTheme(stored.family, stored.mode, false);
    this.foldStatus = display.getFoldStatus();
    display.on('foldStatusChange', this.foldChanged);
    this.notificationChanged();
    this.restoreLogin();
  }
  aboutToDisappear(): void { this.loginAttempt++; this.workspace.api.invalidate(); this.confirmation?.close(); if (this.scrollTimer !== -1) clearTimeout(this.scrollTimer); this.announcements.dispose(this.workspace.api); this.workspace.dispose(); display.off('foldStatusChange', this.foldChanged); }
  onBackPress(): boolean {
    if (this.workspace.panel === 'file' && this.fileFull) { this.fileFull = false; return true; }
    if (this.workspace.panel) { this.closePanel(); return true; }
    if (this.workspace.sidebar) { this.workspace.sidebar = false; return true; }
    return false;
  }
  private systemThemeChanged(): void { if (this.themeMode === 'system') this.applyTheme(this.colors.family, 'system', false); }
  private notificationChanged(): void {
    if (!this.notificationRoute) return;
    this.run(async () => {
      const raw = this.notificationRoute;
      const route = JSON.parse(raw) as NotificationRoute;
      if (!this.workspace.authenticated) { this.server = route.server.slice(0, -7); return; }
      if (await this.workspace.openNotification(route.server, route.session)) {
        if (this.notificationRoute === raw) this.notificationRoute = '';
      } else { this.workspace.notice = 'This notification belongs to another server. Sign in there to open it.'; }
    });
  }
  private applyTheme(family: string, mode: string, persist: boolean = true): void {
    this.themeMode = mode;
    const systemDark = (getContext(this) as common.UIAbilityContext).resourceManager.getConfigurationSync().colorMode === 0;
    const styled = applyNativeStyle(this.customCss, palette(family, mode === 'dark' || (mode === 'system' && systemDark)), this.viewportWidth);
    this.colors = styled.palette; this.messageStyles = styled.components; this.cssWarnings = styled.warnings.join(' ');
    window.getLastWindow(getContext(this) as common.UIAbilityContext).then((main: window.Window) => {
      main.setWindowBackgroundColor(this.colors.background);
      return main.setWindowSystemBarProperties({ statusBarColor: this.colors.background, navigationBarColor: this.colors.background,
        statusBarContentColor: this.colors.text, navigationBarContentColor: this.colors.text });
    }).catch(() => {});
    if (persist) this.savePreferences();
  }
  private savePreferences(): void {
    try { writePreferences(this.workspace.storageDir, { server: this.server, family: this.colors.family, mode: this.themeMode, customCss: this.customCss }); }
    catch (_) { this.workspace.error = 'Unable to save device settings.'; }
  }
  private async run(operation: () => Promise<void>): Promise<void> {
    this.workspace.error = '';
    const generation = this.workspace.authenticationVersion();
    try { await operation(); } catch (reason) { if (generation === this.workspace.authenticationVersion()) this.workspace.error = (reason as Error).message; }
    if (this.workspace.notice) { if (this.noticeTimer !== -1) clearTimeout(this.noticeTimer); this.noticeTimer = setTimeout(() => { this.workspace.notice = ''; }, 3500); }
  }
  private hintScope(label: string): string {
    if (['New session', 'Voice announcements', 'Notification settings', 'Help', 'Settings', 'Log out'].includes(label)) return 'sidebar';
    if (['Sessions', 'Files', 'Session details', 'Unattended', 'Interrupt', 'Copy message', 'Dismiss error', 'Search conversation', 'Previous user message', 'Next user message', 'Latest messages', 'Previous search match', 'Next search match', 'Close search', 'Remove attachment', 'Attach files', 'Queue', 'Send'].includes(label)) return 'chat';
    return 'panel';
  }
  private hintPreferred(label: string): string {
    const labels: string[] = ['Sessions', 'Files', 'Session details', 'Unattended', 'New session', 'Help', 'Settings', 'Log out', 'Previous user message', 'Next user message', 'Search conversation', 'Latest messages', 'Attach files', 'Queue', 'Send'];
    const hints: string[] = ['s', 'b', 'd', 'u', 'c', 'h', 'w', 'l', 'p', 'n', '/', 'g', 'a', 'q', 'e'];
    return hints[labels.indexOf(label)] || '';
  }
  private hintKey(event: KeyEvent): boolean {
    if (event.keyCode === 2076 || event.keyCode === 2077) { this.hintMeta = event.type === KeyType.Down; return false; }
    if (event.type !== KeyType.Down || !this.workspace.authenticated || this.nativeHints.typing() || this.hintMeta || event.getModifierKeyState?.(['ctrl']) || event.getModifierKeyState?.(['alt'])) return false;
    const shift = event.getModifierKeyState?.(['shift']);
    const key = event.keyCode >= 2017 && event.keyCode <= 2042 ? String.fromCharCode((shift ? 65 : 97) + event.keyCode - 2017) :
      event.keyCode >= 2000 && event.keyCode <= 2009 ? '' + (event.keyCode - 2000) : event.keyCode === 2070 ? 'Escape' : event.keyCode === 2055 ? 'Backspace' : event.keyCode === 2064 && !shift ? '/' : event.keyText;
    if (this.nativeHints.active()) return this.nativeHints.key(key);
    if (key !== 'f' || shift) return !!this.workspace.panel && this.workspace.panel !== 'file' && this.nativeHints.dialogKey(key, this.hintViewport);
    const wide = this.viewportWidth >= (this.foldStatus !== 0 && this.foldStatus !== 2 ? 680 : 840);
    return this.nativeHints.enter(this.workspace.panel ? ['panel'] : this.workspace.sidebar && !wide ? ['sidebar'] : wide ? ['sidebar', 'chat'] : ['chat'], this.hintViewport);
  }
  private chatKey(event: KeyEvent): void {
    if (event.keyCode === 2076 || event.keyCode === 2077) { this.chatMeta = event.type === KeyType.Down; return; }
    if (this.nativeHints.active()) return;
    if (event.type !== KeyType.Down || this.chatMeta || this.composerFocused || this.workspace.panel || this.workspace.sidebar || event.getModifierKeyState?.(['ctrl']) || event.getModifierKeyState?.(['alt'])) return;
    const shift = event.getModifierKeyState?.(['shift']);
    const key = event.keyCode >= 2017 && event.keyCode <= 2042 ? String.fromCharCode((shift ? 65 : 97) + event.keyCode - 2017) : event.keyCode === 2064 && !shift ? '/' : event.keyText;
    if (key === 'i') focusControl.requestFocus('message-input');
    else if (['j','k','d','u'].includes(key)) { this.followingLatest = false; this.scroller.scrollBy(0, this.chatHeight * (key === 'j' || key === 'k' ? 0.15 : 0.45) * (key === 'j' || key === 'd' ? 1 : -1)); }
    else if (key === 'G') this.run(async () => { this.followingLatest = true; await this.workspace.latest(); this.followTail(); });
    else if (key === 'D' && this.workspace.selected) this.remove(this.workspace.selected);
    else if (key === '/') this.open('search');
    else return;
    event.stopPropagation();
  }
  private panelEntryKey(event: KeyEvent): boolean {
    if (this.workspace.panel && event.type === KeyType.Down && event.keyCode === 2070) return true;
    return false;
  }
  private composerKey(event: KeyEvent): boolean {
    if (event.keyCode === 2076 || event.keyCode === 2077) { this.composerMeta = event.type === KeyType.Down; return false; }
    if (event.type !== KeyType.Down || this.composingText) return false;
    const choices = this.commandHidden ? [] : composerChoices(this.workspace.selected, this.workspace.launchDefaults, this.workspace.draft);
    if (event.keyCode === 2070) {
      if (choices.length) this.commandHidden = true;
      else focusControl.requestFocus('chat-keyboard');
      return true;
    }
    if (choices.length && (event.keyCode === 2012 || event.keyCode === 2013)) {
      const delta = event.keyCode === 2012 ? -1 : 1;
      this.commandIndex = this.commandIndex < 0 ? (delta > 0 ? 0 : choices.length - 1) : (this.commandIndex + delta + choices.length) % choices.length;
      this.commandScroller.scrollToIndex(this.commandIndex, true, ScrollAlign.AUTO);
      return true;
    }
    if (event.keyCode !== 2054) return false;
    if (choices.length) {
      const choice = choices[Math.max(0, Math.min(this.commandIndex, choices.length - 1))];
      this.run(() => this.workspace.chooseCommand(choice)); return true;
    }
    if (this.composerMeta || event.getModifierKeyState?.(['ctrl'])) {
      this.sendMessage(); return true;
    }
    return false;
  }
  private confirmation?: CustomDialogController;
  private confirm(options: ConfirmationOptions): void {
    this.nativeHints.exit();
    this.confirmation?.close();
    this.confirmation = new CustomDialogController({
      builder: Confirmation({ options: options, colors: this.colors }),
      customStyle: true, autoCancel: false, alignment: DialogAlignment.Center,
      onWillDismiss: (_action: DismissDialogAction) => {}
    });
    this.confirmation.open();
  }
  private sendMessage(): void {
    if (!this.workspace.needsAttachmentConfirmation()) { this.run(() => this.workspace.send()); return; }
    const id = this.workspace.selected?.session_id;
    const draft = this.workspace.draft;
    if (!draft.trim() || this.workspace.sending || this.workspace.uploading) return;
    this.confirm({ title: 'Send pending attachment?', message: 'This session has a pending file attachment. Send it with this message?',
      primaryButton: { value: 'Cancel', action: () => {} },
      secondaryButton: { value: 'Send with attachment', action: () => {
        if (this.workspace.selected?.session_id === id && this.workspace.draft === draft) this.run(() => this.workspace.send(false, true));
      } } });
  }
  private async restoreLogin(): Promise<void> {
    if (this.connecting || !this.server) return;
    this.connecting = true;
    const attempt = ++this.loginAttempt;
    const server = this.server;
    try {
      const password = await this.savedLogin.password(server);
      if (attempt !== this.loginAttempt || server !== this.server) return;
      this.password = password;
      if (password) await this.signIn(server, password, attempt);
    } catch (reason) { if (attempt === this.loginAttempt) this.workspace.error = (reason as Error).message; }
    finally { if (attempt === this.loginAttempt) this.connecting = false; }
  }
  private async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    const attempt = ++this.loginAttempt;
    try { await this.signIn(this.server, this.password, attempt); }
    catch (reason) { if (attempt === this.loginAttempt) this.workspace.error = (reason as Error).message; }
    finally { if (attempt === this.loginAttempt) this.connecting = false; }
  }
  private async signIn(server: string, password: string, attempt: number): Promise<void> {
    this.workspace.error = '';
    if (!this.rememberPassword) await this.savedLogin.clear();
    try { await this.workspace.login(server, password); }
    catch (reason) {
      const status = (reason as ApiError).status;
      if (attempt === this.loginAttempt && (status === 401 || status === 403)) {
        this.password = '';
        await this.savedLogin.clear();
      }
      throw reason as Error;
    }
    if (attempt !== this.loginAttempt || !this.workspace.authenticated) return;
    this.password = ''; this.savePreferences();
    if (this.rememberPassword) {
      try { await this.savedLogin.save(server, password); }
      catch (reason) { this.workspace.error = (reason as Error).message; }
    }
    if (attempt !== this.loginAttempt) return;
    this.notificationChanged();
    if (nativePush.requested(this.workspace.api.address('/api/me'))) await this.announcements.setNotifications(this.workspace.api, true, getContext(this) as common.UIAbilityContext);
    else if (nativePush.hasRegistration()) await nativePush.revokeLocal();
  }
  private async signOut(): Promise<void> {
    // Clear before network cleanup so an offline logout cannot auto-sign in later.
    this.loginAttempt++; this.password = '';
    await this.savedLogin.clear();
    await nativePush.disable(this.workspace.api);
    this.announcements.dispose(this.workspace.api);
    await this.workspace.logout();
  }
  private async pickFile(): Promise<void> {
    const sessionId = this.workspace.selected?.session_id;
    const generation = this.workspace.authenticationVersion();
    const selector = new picker.DocumentViewPicker(getContext(this) as common.UIAbilityContext);
    const uris = await selector.select({ maxSelectNumber: 10 });
    for (const uri of uris) {
      if (sessionId !== this.workspace.selected?.session_id || generation !== this.workspace.authenticationVersion()) return;
      await this.workspace.upload(uri);
    }
  }
  private async pickPhotos(): Promise<void> {
    const sessionId = this.workspace.selected?.session_id;
    const generation = this.workspace.authenticationVersion();
    const result = await new photoAccessHelper.PhotoViewPicker().select({ MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_VIDEO_TYPE, maxSelectNumber: 10 });
    for (const uri of result.photoUris) {
      if (sessionId !== this.workspace.selected?.session_id || generation !== this.workspace.authenticationVersion()) return;
      await this.workspace.upload(uri);
    }
  }
  private attachmentMenu(): void {
    ActionSheet.show({ title: 'Attach files', message: 'Choose an attachment source', sheets: [
      { title: 'Files', action: () => { this.run(() => this.pickFile()); } },
      { title: 'Photos and videos', action: () => { this.run(() => this.pickPhotos()); } }
    ], confirm: { value: 'Cancel', action: () => {} } });
  }
  private open(panel: string): void {
    this.nativeHints.exit(); this.workspace.panel = panel;
    setTimeout(() => { if (this.workspace.panel === panel) focusControl.requestFocus('Close'); }, 80);
    this.workspace.sidebar = false;
    if (panel === 'unattended') this.run(async () => {
      await this.workspace.loadUnattended();
      this.autoEnabled = this.workspace.unattended.enabled;
      this.autoRequest = this.workspace.unattended.request;
      this.autoCooldown = '' + this.workspace.unattended.cooldown_minutes;
      this.autoRemaining = '' + this.workspace.unattended.remaining_injections;
    });
    if (panel === 'settings') this.run(async () => {
      await this.announcements.load(this.workspace.api);
      this.voiceUrl = this.announcements.settings.tts_base_url; this.voiceNarration = this.announcements.settings.tts_enabled_for_narration;
      this.voiceKey = ''; this.voiceClearKey = false; this.globalPrompt = this.announcements.prompt;
    });
    if (panel === 'queue') this.run(() => this.workspace.loadQueue());
    if (panel === 'files') { this.filePickerLocation = ''; this.run(() => this.workspace.loadFiles()); }
    if (panel === 'new') {
      this.cwd = this.workspace.selected?.cwd || this.workspace.recentCwds[0] || '';
      this.newName = ''; this.directoryPicker = false; this.resumeId = ''; this.branch = ''; this.tmux = this.workspace.tmuxAvailable;
      const remembered = this.launchChoices.find((choice: LaunchChoice) => choice.server === this.workspace.api.address('/api/me'));
      this.chooseBackend(this.workspace.selected?.agent_backend || remembered?.backend || this.workspace.launchDefaults.default_backend);
    }
  }
  private defaults(): LaunchDefaults { return this.workspace.launchDefaults.backends[this.backend] || {}; }
  private chooseBackend(backend: string): void {
    this.backend = backend;
    const defaults = this.defaults();
    const remembered = this.launchChoices.find((choice: LaunchChoice) => choice.server === this.workspace.api.address('/api/me') && choice.backend === backend);
    const choices = defaults.provider_choices || [];
    this.provider = remembered && (!choices.length || choices.includes(remembered.provider)) ? remembered.provider : defaults.provider_choice || defaults.model_provider || choices[0] || '';
    this.model = remembered && remembered.provider === this.provider ? remembered.model : defaults.model || '';
    this.effort = defaults.reasoning_effort || '';
    this.fast = defaults.service_tier === 'fast';
    this.rememberLaunchChoice(); this.scheduleLaunchContext();
  }
  private resumeOptions(): SelectOption[] {
    const options: SelectOption[] = [{ value: 'Start fresh' }];
    return options.concat(this.launchContext.candidates.map((item: ResumeCandidate): SelectOption => { return { value: item.alias || item.first_user_message || item.session_id }; }));
  }
  private scheduleLaunchContext(): void {
    this.resumeId = ''; this.branch = ''; this.launchContext.cancel();
    if (this.launchTimer !== -1) clearTimeout(this.launchTimer);
    this.launchTimer = setTimeout(() => {
      this.launchTimer = -1;
      if (this.workspace.panel === 'new') {
        this.launchContext.load(this.workspace.api, this.cwd, this.backend);
        if (this.directoryPicker) this.run(() => this.launchContext.suggest(this.workspace.api, this.cwd, this.workspace.recentCwds));
      }
    }, 250);
  }
  private rememberLaunchChoice(): void {
    this.launchChoices = rememberLaunch(this.launchChoices, { server: this.workspace.api.address('/api/me'), backend: this.backend, provider: this.provider, model: this.model });
    try { writeLaunchChoices(this.workspace.storageDir, this.launchChoices); }
    catch (_) { this.workspace.error = 'Unable to save launch preferences.'; }
  }
  private modelOptions(): string[] {
    const defaults = this.defaults();
    return defaults.provider_models?.[this.provider] || defaults.models || [];
  }
  private edit(session: Session): void {
    this.editSession = session;
    this.editText = sessionName(session);
    this.priority = session.priority_offset || 0;
    this.snoozeUntil = session.snooze_until || null;
    this.snoozeMode = this.snoozeUntil && this.snoozeUntil > Date.now() / 1000 ? 'custom' : 'none';
    const date = new Date((this.snoozeUntil || tomorrowMorning()) * 1000);
    this.snoozeDate = date.getFullYear() + '-' + (date.getMonth() + 1).toString().padStart(2, '0') + '-' + date.getDate().toString().padStart(2, '0');
    this.snoozeTime = date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
    this.dependency = session.dependency_session_id || '';
    this.open('rename');
  }
  private closePanel(): void {
    this.nativeHints.exit();
    if (this.workspace.panel === 'new') { this.launchContext.cancel(); if (this.launchTimer !== -1) clearTimeout(this.launchTimer); }
    if (this.workspace.fileDirty && this.workspace.panel === 'file') {
      this.confirm({ title: 'Discard unsaved changes?', message: 'Your changes have not been saved.',
        primaryButton: { value: 'Keep editing', action: () => {} },
        secondaryButton: { value: 'Discard', action: () => { this.workspace.discardFile(); this.finishClosePanel(); } } });
    } else this.finishClosePanel();
  }
  private finishClosePanel(): void {
    this.workspace.panel = '';
    setTimeout(() => { if (!this.workspace.panel) focusControl.requestFocus('chat-keyboard'); }, 80);
  }
  private filePickerLocation: string = '';
  private directoryReference(path: string): void { this.open('new'); this.cwd = path; this.scheduleLaunchContext(); }
  private link(url: string): void {
    if (url.startsWith('codoxear-file:')) {
      const ref = parseFileReferenceLink(url);
      if (ref) this.run(() => this.workspace.openFileReference(ref.path, ref.location, (path: string) => { this.directoryReference(path); }, ref.apiPath));
      return;
    }
    if (url.startsWith('codoxear-directory:')) { this.directoryReference(decodeURIComponent(url.slice('codoxear-directory:'.length))); return; }
    if (url.startsWith('codoxear-choice:')) {
      const ref = fileLocation(decodeURIComponent(url.slice('codoxear-choice:'.length)));
      this.searchText = ref.path; this.filePickerLocation = ref.location; this.workspace.panel = 'files';
      this.run(() => this.workspace.loadFiles(ref.path)); return;
    }
    if (/^(https?:\/\/|mailto:)/i.test(url)) {
      this.run(async () => { await (getContext(this) as common.UIAbilityContext).startAbility({ action: 'ohos.want.action.viewData', uri: url }); });
    } else {
      const ref = fileLocation(url);
      if (!ref.path) { this.workspace.fileLocation = ref.location; return; }
      this.run(() => this.workspace.openFileReference(ref.path, ref.location, (path: string) => { this.directoryReference(path); }));
    }
  }
  private followTail(): void {
    if (!this.followingLatest || this.scrollTimer !== -1) return;
    const id = this.workspace.selected?.session_id;
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = -1;
      if (this.followingLatest && id === this.workspace.selected?.session_id) this.scroller.scrollEdge(Edge.Bottom);
    }, 50);
  }
  private async loadOlder(): Promise<void> {
    this.followingLatest = false;
    const id = this.workspace.selected?.session_id;
    const event = this.workspace.events[this.visibleMessageIndex];
    const key = event ? eventKey(event) : '';
    const y = this.scroller.getItemRect(this.visibleMessageIndex + (this.workspace.hasOlder ? 1 : 0)).y;
    await this.workspace.older();
    setTimeout(() => {
      if (id !== this.workspace.selected?.session_id || !key) return;
      const index = this.workspace.events.findIndex((item: ChatEvent) => eventKey(item) === key);
      if (index >= 0) {
        this.scroller.scrollToIndex(index + (this.workspace.hasOlder ? 1 : 0), false, ScrollAlign.START);
        this.scroller.scrollBy(0, -y);
      }
    }, 100);
  }
  private scrollToMessage(index: number): void {
    if (index < 0) return;
    this.followingLatest = false;
    const id = this.workspace.selected?.session_id;
    const key = this.workspace.events[index] ? eventKey(this.workspace.events[index]) : '';
    setTimeout(() => {
      if (id !== this.workspace.selected?.session_id || !key) return;
      const current = this.workspace.events.findIndex((event: ChatEvent) => eventKey(event) === key);
      if (current >= 0) this.scroller.scrollToIndex(current + (this.workspace.hasOlder ? 1 : 0), false, ScrollAlign.START);
    }, 100);
  }
  private async navigateUser(direction: number): Promise<void> {
    if (this.navigating) return;
    this.navigating = true;
    try {
      let index = this.visibleMessageIndex;
      if (direction < 0) {
        const rect = this.scroller.getItemRect(index + (this.workspace.hasOlder ? 1 : 0));
        if (rect.y < -24) index++;
      }
      this.scrollToMessage(await this.workspace.navigateUser(index, direction));
    } finally { this.navigating = false; }
  }
  private copy(text: string): void {
    this.run(async () => { await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text)); this.workspace.notice = 'Copied'; });
  }
  private copyConversation(): void {
    this.run(async () => {
      try {
        const result = await this.workspace.exportConversation();
        if (!result) return;
        if (!result.text) { this.workspace.notice = 'No conversation to copy'; return; }
        await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, result.text));
        this.workspace.notice = 'Copied ' + result.messageCount + (result.messageCount === 1 ? ' message' : ' messages');
      } catch (reason) { this.workspace.notice = conversationCopyFailure(reason as Error); }
    });
  }
  private removeQueued(item: QueueItem): void {
    const recovery = item.commit_unknown || item.orphan_recovery;
    this.confirm({ title: recovery ? 'Delete recovery item?' : 'Delete queued prompt?',
      message: recovery ? 'Check the transcript or terminal before deleting. Remaining queued prompts will stay in recovery for separate review.' : 'Delete this prompt from the queue? It will not be sent.',
      primaryButton: { value: 'Cancel', action: () => {} },
      secondaryButton: { value: 'Delete', action: () => { this.run(() => this.workspace.changeQueue('delete', { id: item.id, allow_commit_unknown: !!item.commit_unknown, allow_orphan_recovery: !!item.orphan_recovery })); } } });
  }
  private remove(session: Session): void {
    const dismiss = launchFailed(session) || launchPending(session);
    this.confirm({ title: session.lost ? 'Dismiss lost session?' : dismiss ? 'Dismiss launch record?' : 'Delete session?', message: sessionName(session),
      primaryButton: { value: 'Cancel', action: () => {} },
      secondaryButton: { value: dismiss ? 'Dismiss' : 'Delete', action: () => { this.run(async () => {
        await this.workspace.action('delete', '{}', session.session_id);
        if (this.workspace.selected?.session_id === session.session_id) { this.workspace.selected = undefined; this.workspace.events = []; }
      }); } } });
  }
  private iconFilters: Map<string, drawing.ColorFilter> = new Map();
  private iconTint(value: string): drawing.ColorFilter {
    let filter = this.iconFilters.get(value);
    if (!filter) {
      const color = ColorMetrics.resourceColor(value);
      filter = drawing.ColorFilter.createBlendModeColorFilter({ red: color.red, green: color.green, blue: color.blue, alpha: color.alpha }, drawing.BlendMode.SRC_IN);
      this.iconFilters.set(value, filter);
    }
    return filter;
  }
  @Builder
  icon(name: string, label: string | (() => string), action: () => void, active: boolean | (() => boolean) = false, enabled: () => boolean = () => true, plain: boolean = false) {
    HintTarget({ label: typeof label === 'string' ? label : label(), button: true, scope: this.hintScope(typeof label === 'string' ? label : label()), preferred: this.hintPreferred(typeof label === 'string' ? label : label()), available: enabled(), activate: action }) {
    Button({ type: ButtonType.Normal }) {
      Image($rawfile('icons/' + ((typeof active === 'boolean' ? active : active()) ? 'primary' : this.colors.mode) + '/' + name + '.svg')).width(18).height(18)
        .colorFilter(this.iconTint((typeof active === 'boolean' ? active : active()) ? this.colors.onPrimary : this.colors.ink))
    }.width(32).height(32).padding(6).responseRegion({ x: -6, y: -6, width: 44, height: 44 }).borderRadius(this.colors.radius)
      .backgroundColor((typeof active === 'boolean' ? active : active()) ? this.colors.primary : Color.Transparent)
      .border({ width: plain || this.colors.family === 'slate' ? 0 : 1, color: (typeof active === 'boolean' ? active : active()) ? this.colors.primary : this.colors.hairline })
      .borderRadius(this.colors.radius).accessibilityText(typeof label === 'string' ? label : label()).id(typeof label === 'string' ? label : label()).enabled(enabled()).onClick(action)
    }
  }
  @Builder
  button(text: string | (() => string), action: () => void, primary: boolean | (() => boolean) = false, scope: string = 'panel') {
    HintTarget({ label: typeof text === 'string' ? text : text(), button: true, scope: scope, activate: action }) {
    Button(typeof text === 'string' ? text : text(), { type: ButtonType.Normal }).height(40).responseRegion({ x: 0, y: -2, width: '100%', height: 44 }).fontSize(13).fontWeight(FontWeight.Normal)
      .borderRadius(this.colors.radius).padding({ left: 12, right: 12 })
      .backgroundColor((typeof primary === 'boolean' ? primary : primary()) ? this.colors.primary : this.colors.paper).fontColor((typeof primary === 'boolean' ? primary : primary()) ? this.colors.onPrimary : this.colors.text)
      .border({ width: 1, color: (typeof primary === 'boolean' ? primary : primary()) ? this.colors.primary : this.colors.hairline }).borderRadius(this.colors.radius).onClick(action)
    }
  }
  @Builder
  fileTab(text: () => string, action: () => void, active: () => boolean) {
    HintTarget({ label: text(), activate: action }) {
    Button(text(), { type: ButtonType.Normal }).height(28).responseRegion({ x: 0, y: -8, width: '100%', height: 44 }).fontSize(12).fontWeight(FontWeight.Normal)
      .padding({ left: 8, right: 8 }).borderRadius(this.colors.radius)
      .backgroundColor(active() ? this.colors.subtle : Color.Transparent).fontColor(this.colors.text)
      .border({ width: { bottom: active() ? 2 : 0 }, color: this.colors.accent }).onClick(action)
    }
  }
  private downloadFile(): void {
    this.run(async () => {
      const file = this.workspace.activeFile; if (!file) return;
      const saved = await exportFile(getContext(this) as common.UIAbilityContext, this.workspace.api, this.workspace.fileDownloadPath(), (file.rel || file.path).split('/').pop() || 'download');
      if (saved) this.workspace.notice = 'File saved to device';
    });
  }
  @Builder
  field(label: string, value: () => string, change: (value: string) => void) {
    Column({ space: 6 }) {
      Text(label).fontSize(12).fontColor(this.colors.muted).width('100%')
      HintTarget({ label: label, activate: () => { focusControl.requestFocus(label); } }) {
      TextInput({ text: value(), placeholder: label }).id(label).placeholderColor(this.colors.muted).height(44).fontSize(14).fontColor(this.colors.text)
        .backgroundColor(this.colors.paper).borderRadius(this.colors.radius).border({ width: 1, color: this.colors.hairline }).onChange(change).onFocus(() => { this.nativeHints.focus(label); }).onBlur(() => { this.nativeHints.blur(label); }).onKeyPreIme((event: KeyEvent): boolean => this.panelEntryKey(event))
      }
    }.width('100%')
  }
  @Builder
  login() {
    Column({ space: 16 }) {
      Text('Codoxear login').fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.colors.ink).width('100%')
      this.field('Server address', () => this.server, (value: string) => { if (this.server !== value) this.password = ''; this.server = value; })
      Row({ space: 10 }) {
        TextInput({ placeholder: 'Password', text: this.password }).id('password').placeholderColor(this.colors.muted).type(InputType.Password).passwordIcon({ onIconSrc: $rawfile('icons/' + this.colors.mode + '/eye.svg'), offIconSrc: $rawfile('icons/' + this.colors.mode + '/eye-off.svg') })
          .height(44).layoutWeight(1).borderRadius(this.colors.radius).backgroundColor(this.colors.paper)
          .fontColor(this.colors.text).border({ width: 1, color: this.colors.border })
          .onChange((value: string) => { this.password = value; }).onSubmit(() => { this.connect(); })
        this.button(() => this.connecting ? '…' : 'Login', () => { this.connect(); }, true)
      }
      Row({ space: 8 }) {
        Checkbox({ name: 'remember-password' }).id('remember-password').select(this.rememberPassword)
          .selectedColor(this.colors.accent).onChange((value: boolean) => { this.rememberPassword = value; })
        Text('Remember password').fontSize(14).fontColor(this.colors.text)
          .onClick(() => { this.rememberPassword = !this.rememberPassword; })
      }.width('100%')
      Text('Sign in automatically on this device. Logging out removes the saved password.')
        .fontSize(12).fontColor(this.colors.muted).width('100%')
      if (this.workspace.error) { Text(this.workspace.error).fontColor(this.colors.danger).fontSize(13).width('100%') }
    }.width('100%').constraintSize({ maxWidth: 420 }).padding(24).enabled(!this.connecting)
  }
  private currentSession(session: Session): Session {
    return this.workspace.sessions.find((row: Session) => row.session_id === session.session_id) || session;
  }
  private selectHintSession(session: Session): void {
    session = this.currentSession(session);
    if (launchPending(session)) this.workspace.notice = 'Session still starting';
    else if (session.launch_state === 'failed' && !session.orphan_recovery) { this.workspace.details = session.launch_error || 'Session launch failed.'; this.open('details'); }
    else this.run(() => this.workspace.select(session));
  }
  @Builder
  sessionRow(session: Session) {
    HintTarget({ label: sessionName(session), scope: 'sidebar', session: true, activate: () => this.selectHintSession(session) }) {
    Column({ space: 7 }) {
      Row({ space: 8 }) {
        SessionStateDot({ colors: this.colors, pending: launchPending(session), busy: !!session.busy, suppressed: !!session.blocked || !!session.snoozed, label: launchPending(session) ? 'Starting' : session.blocked ? 'Waiting' : session.snoozed ? 'Snoozed' : session.busy ? 'Busy' : 'Idle' })
        if (session.subagents_running) { Text('▸' + session.subagents_running).fontSize(12).fontColor(this.colors.muted) }
        Text(sessionName(session)).fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.colors.text).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
        if (session.service_tier === 'fast') { Image($rawfile('icons/' + this.colors.mode + '/lightning.svg')).width(11).height(11).colorFilter(this.iconTint(this.colors.muted)).accessibilityText('Fast session') }
        ForEach(sessionBadges(session), (badge: string) => { Text(badge).fontSize(10).fontColor(badge === 'lost' || badge === 'failed' ? this.colors.danger : this.colors.muted).padding({ left: 5, right: 5, top: 2, bottom: 2 }).backgroundColor(this.colors.subtle).borderRadius(this.colors.radius).border({ width: 1, color: this.colors.hairline }) })
      }.width('100%')
      Row({ space: 6 }) {
        Image($rawfile('logos/' + this.colors.family + '-' + this.colors.mode + '/' + sessionBackend(session) + '.svg')).width(10).height(10).accessibilityText(sessionBackend(session) === 'cc' ? 'Claude logo' : sessionBackend(session) === 'pi' ? 'Pi logo' : 'Codex logo')
        Image($rawfile('icons/' + this.colors.mode + '/' + sessionLaunchIcon(session) + '.svg')).width(12).height(12).colorFilter(this.iconTint(this.colors.muted)).accessibilityText(sessionLaunchIcon(session) === 'tmux' ? 'tmux session' : sessionLaunchIcon(session) === 'web' ? 'Web session' : sessionLaunchIcon(session) === 'terminal' ? 'Terminal session' : 'Failed session')
        Text(sessionMetadata(session)).id('session-meta-' + session.session_id).fontSize(12).fontColor(this.colors.muted).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
      }.width('100%')
    }.alignItems(HorizontalAlign.Start).padding(8).width('100%').borderRadius(this.colors.cardRadius)
      .backgroundColor(this.workspace.selected?.session_id === session.session_id ? this.colors.activeSession : this.colors.family === 'slate' ? this.colors.panel : this.colors.paper)
      .border({ width: { top: 1, right: 1, bottom: 1, left: this.colors.family === 'paper' && this.workspace.selected?.session_id === session.session_id ? 3 : 1 }, color: this.colors.family === 'slate' ? Color.Transparent : this.workspace.selected?.session_id === session.session_id ? this.colors.accent : this.colors.family === 'clay' ? this.colors.hairline : this.colors.border })
      .onClick(() => { this.selectHintSession(session); })
      .bindContextMenu(this.sessionMenu(session), ResponseType.LongPress)
    }
  }
  @Builder
  sessionMenu(session: Session) {
    Menu() {
      if (!launchPending(session) && !launchFailed(session)) {
        MenuItem({ content: 'Edit session' }).onClick(() => { this.edit(this.currentSession(session)); })
        MenuItem({ content: 'Duplicate session' }).onClick(() => { this.run(() => this.workspace.create(duplicateRequest(this.currentSession(session)))); })
      }
      MenuItem({ content: launchFailed(session) || launchPending(session) ? 'Dismiss' : 'Delete' }).onClick(() => { this.remove(this.currentSession(session)); })
    }
  }
  @Builder
  sessionSwipe(session: Session, start: boolean) {
    Row({ space: 8 }) {
      if (start) { this.icon('trash', launchFailed(session) || launchPending(session) ? 'Dismiss' : 'Delete', () => { this.remove(this.currentSession(session)); }) }
      else if (!launchFailed(session) && !launchPending(session)) {
        this.icon('edit', 'Edit', () => { this.edit(this.currentSession(session)); })
        this.icon('duplicate', 'Duplicate', () => { this.run(() => this.workspace.create(duplicateRequest(this.currentSession(session)))); })
      }
    }.padding({ left: 10, right: 10 }).height('100%').backgroundColor(themeVariables(this.colors.family, this.colors.mode === 'dark')[start ? 'surface-danger' : 'surface-muted'])
  }
  @Builder
  sidebarFooterButton(name: string, label: string, action: () => void) {
    Column() {
    HintTarget({ label: label, button: true, scope: 'sidebar', preferred: this.hintPreferred(label), activate: action }) {
      Button({ type: ButtonType.Normal }) {
        Row({ space: 8 }) {
          Image($rawfile('icons/' + this.colors.mode + '/' + name + '.svg')).width(16).height(16).colorFilter(this.iconTint(this.colors.ink))
          Text(label).fontSize(13).fontColor(this.colors.text).maxLines(1)
        }
      }.id(label).accessibilityText(label).height(44).width('100%').padding(0).borderRadius(this.colors.radius).backgroundColor(this.colors.paper).border({ width: 1, color: this.colors.hairline }).borderRadius(this.colors.radius).onClick(action)
    }
    }.layoutWeight(1)
  }
  @Builder
  sidebar() {
    Column() {
      Row({ space: 8 }) {
        Image($rawfile('logos/' + this.colors.family + '-' + this.colors.mode + '/brand.svg')).width(20).height(20)
        Text('Codoxear').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.colors.ink).layoutWeight(1)
        this.icon('plus', 'New session', () => { this.open('new'); })
        this.icon('bell', 'Notification settings', () => { this.open('settings'); }, () => this.announcements.notifications)
        this.icon('volume', 'Voice announcements', () => { this.run(() => this.announcements.setListening(this.workspace.api, !this.announcements.listening)); }, () => this.announcements.listening)
      }.width('100%').padding({ left: 14, right: 14 }).height(56).border({ width: { bottom: 1 }, color: this.colors.hairline })
      List({ space: 6 }) {
        ForEach(['Now', 'Waiting', 'Later'], (group: string, index: number) => {
          if (this.workspace.sessions.some((row: Session) => sessionGroup(row) === index)) {
            ListItem() {
              Row() {
                Text(group.toUpperCase()).fontSize(11).fontWeight(FontWeight.Bold).letterSpacing(0.88).fontColor(themeVariables(this.colors.family, this.colors.mode === 'dark')['text-subtle'])
                Blank()
                Text(this.workspace.sessions.filter((row: Session) => sessionGroup(row) === index).length.toString()).fontSize(11).fontColor(this.colors.ink).padding({ left: 7, right: 7, top: 1, bottom: 1 }).border({ width: 1, color: themeVariables(this.colors.family, this.colors.mode === 'dark')['border-count'] }).borderRadius(this.colors.family === 'paper' ? 0 : 99).backgroundColor(this.colors.family === 'slate' ? Color.Transparent : this.colors.subtle)
              }.width('100%').padding({ top: 10, bottom: 0, left: 4, right: 4 })
            }
          }
          ForEach(this.workspace.sessions.filter((row: Session) => sessionGroup(row) === index), (session: Session) => {
            ListItem() { this.sessionRow(session) }.swipeAction({ start: this.sessionSwipe(session, true), end: this.sessionSwipe(session, false), edgeEffect: SwipeEdgeEffect.None })
          }, (session: Session) => sessionCardKey(session))
        })
      }.layoutWeight(1).padding({ left: this.viewportWidth <= 520 ? 6 : 8, right: this.viewportWidth <= 520 ? 6 : 8, top: 6 }).width('100%')
      Row({ space: 12 }) {
        this.sidebarFooterButton('help', 'Help', () => { this.open('help'); })
        this.sidebarFooterButton('settings', 'Settings', () => { this.open('settings'); })
        this.sidebarFooterButton('logout', 'Log out', () => { this.run(async () => { await this.signOut(); }); })
      }.padding({ left: 12, right: 12, top: 3, bottom: 3 }).width('100%').border({ width: { top: 1 }, color: this.colors.hairline })
    }.height('100%').width(this.viewportWidth <= 520 ? this.viewportWidth : this.viewportWidth >= 880 ? 380 : this.foldStatus !== 0 && this.foldStatus !== 2 && this.viewportWidth >= 680 ? 240 : 320).backgroundColor(this.colors.panel).border({ width: { right: 1 }, color: this.colors.hairline })
  }
  @Builder
  topbar() {
    Row({ space: 6 }) {
      if (this.viewportWidth < (this.foldStatus !== 0 && this.foldStatus !== 2 ? 680 : 840)) { this.icon('menu', 'Sessions', () => { this.workspace.sidebar = true; }) }
      Column() {
      HintTarget({ label: 'Session title', scope: 'chat', preferred: 't', available: !!this.workspace.selected, activate: () => { if (this.workspace.selected) this.edit(this.workspace.selected); } }) {
      Text(this.workspace.selected ? sessionName(this.workspace.selected) : 'Codoxear').id('chat-keyboard').focusable(true).onClick(() => { if (this.workspace.selected) this.edit(this.workspace.selected); }).fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.colors.text).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).textAlign(TextAlign.Center).width('100%')
      }
      }.layoutWeight(1)
      if (contextLabel(this.workspace.activity.token)) {
        Text(contextLabel(this.workspace.activity.token)).fontSize(11).fontFamily('monospace').fontColor(this.colors.muted).padding(6).onClick(() => { this.run(() => this.workspace.diagnostics()); })
      }
      this.icon('file', 'Files', () => { if (this.workspace.selected) this.open('files'); })
      this.icon('info', 'Session details', () => { if (this.workspace.selected) this.run(() => this.workspace.diagnostics()); })
      this.icon('unattended', 'Unattended', () => { if (this.workspace.selected) this.open('unattended'); })
      if (this.workspace.busy) { this.icon('stop', 'Interrupt', () => { this.run(() => this.workspace.action('interrupt')); }, true) }
    }.height(56).width('100%').padding({ left: 10, right: 10 }).backgroundColor(this.colors.panel).border({ width: { bottom: 1 }, color: this.colors.hairline })
  }
  private messageStyle(event: ChatEvent): ComponentStyle { return event.role === 'user' ? this.messageStyles.user : this.messageStyles.assistant; }
  private messageColors(event: ChatEvent): Palette { const colors = JSON.parse(JSON.stringify(this.colors)) as Palette; colors.text = this.messageStyle(event).color; return colors; }
  private bubbleWidth(event: ChatEvent): number {
    const style = this.messageStyle(event);
    const maximum = Math.max(36, Math.min(style.maxWidth, this.chatWidth * 0.82, this.chatWidth - 36));
    const padding = style.paddingLeft + style.paddingRight + style.borderWidth * 2;
    let widest = 0;
    for (const block of markdownBlocks(event.text || '')) {
      if (['code', 'table', 'image', 'math', 'rule'].includes(block.kind) || block.parts.some((part: InlinePart) => !!part.math || part.image)) return maximum;
      const size = block.kind === 'heading' ? (block.level === 1 ? 18 : block.level === 2 ? 16 : 14) : style.fontSize;
      const line = measureInlineWidth(block.parts, (text: string, part: InlinePart): number => px2vp(this.getUIContext().getMeasureUtils().measureText({ textContent: text, fontSize: size, fontWeight: part.bold || block.kind === 'heading' ? 'bold' : 'normal', fontStyle: part.italic ? FontStyle.Italic : FontStyle.Normal, fontFamily: part.code ? 'monospace' : 'HarmonyOS Sans' })));
      widest = Math.max(widest, line + Math.max(0, block.indent - 1) * 16 + (block.quote ? 15 : 0) + (block.prefix ? 30 : 0) + (block.checked >= 0 ? 30 : 0));
      if (widest + padding >= maximum) return maximum;
    }
    return Math.min(maximum, Math.max(54, Math.ceil(widest + padding)));
  }
  private messageKey(event: ChatEvent): string { return (this.workspace.selected?.session_id || '') + ':' + eventKey(event); }
  private toggleMessageCopy(event: ChatEvent): void { const key = this.messageKey(event); this.copyMessageKey = this.copyMessageKey === key ? '' : key; }
  @Builder
  messageCopy(event: ChatEvent) {
    Row() { this.icon('copy', 'Copy message', () => { this.copy(event.text || ''); }) }
      .visibility(this.copyMessageKey === this.messageKey(event) || this.hoverMessageKey === this.messageKey(event) ? Visibility.Visible : Visibility.Hidden)
  }
  @Builder
  bubble(event: ChatEvent) {
    Row({ space: 4 }) {
      if (event.role === 'user') { this.messageCopy(event) }
      Stack({ alignContent: Alignment.BottomEnd }) {
        MarkdownView({ hintClip: this.hintChatClip, text: event.text || '', searchQuery: this.workspace.searchQuery, colors: this.messageColors(event), fontSize: this.messageStyle(event).fontSize, lineHeight: this.messageStyle(event).lineHeight, sessionId: this.workspace.selected?.session_id || '', api: this.workspace.api, onLink: (url: string) => { this.link(url); }, onCopy: (text: string) => { this.copy(text); }, onTap: () => { this.toggleMessageCopy(event); } })
          .padding({ left: this.messageStyle(event).paddingLeft, right: this.messageStyle(event).paddingRight, top: this.messageStyle(event).paddingTop, bottom: this.messageStyle(event).paddingBottom })
        if (event.ts) { Text(new Date(event.ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })).fontSize(11).fontFamily('monospace').fontColor(this.colors.muted).margin({ right: 10, bottom: 6 }) }
      }.width(this.bubbleWidth(event)).backgroundColor(this.messageStyle(event).background)
        .borderRadius(this.messageStyle(event).radius).border({ width: this.messageStyle(event).borderWidth, color: this.messageStyle(event).borderColor })
        .onAreaChange(() => { this.followTail(); })
        .onClick(() => { this.toggleMessageCopy(event); })
      if (event.role !== 'user') { this.messageCopy(event) }
    }.width('100%').alignItems(VerticalAlign.Bottom).justifyContent(event.role === 'user' ? FlexAlign.End : FlexAlign.Start)
      .onHover((hovered: boolean) => { const key = this.messageKey(event); if (hovered) this.hoverMessageKey = key; else if (this.hoverMessageKey === key) this.hoverMessageKey = ''; })
  }
  @Builder
  conversation() {
    Column() {
      this.topbar()
      if (this.workspace.error) {
        Row() { Text(this.workspace.error).fontSize(12).fontColor(this.colors.danger).layoutWeight(1); this.icon('x', 'Dismiss error', () => { this.workspace.error = ''; }) }
          .padding({ left: 12, right: 6 }).backgroundColor(this.colors.wash).width('100%')
      }
      if (this.workspace.connectionStatus) { Text(this.workspace.connectionStatus).fontSize(12).fontColor(this.colors.muted).width('100%').padding(8).backgroundColor(this.colors.wash) }
      if (this.workspace.notice) { Text(this.workspace.notice).fontSize(12).fontColor(this.colors.muted).width('100%').padding(6).onClick(() => { this.workspace.notice = ''; }) }
      if (this.workspace.selected) {
        Row({ space: 12 }) {
          Blank()
          this.icon('search', 'Search conversation', () => { this.open('search'); })
          this.icon('up', 'Previous user message', () => { this.run(() => this.navigateUser(-1)); })
          this.icon('down', 'Next user message', () => { this.run(() => this.navigateUser(1)); })
        }.padding({ left: 16, right: 12 }).height(44).width('100%')
        Stack({ alignContent: Alignment.Bottom }) {
        List({ scroller: this.scroller }) {
          if (this.workspace.hasOlder) { ListItem() { this.button('Load older messages', () => { this.run(() => this.loadOlder()); }, false, 'chat') } }
          ForEach(this.workspace.events, (event: ChatEvent, index: number) => {
            ListItem() {
              Column() {
                if (startsTranscriptDay(this.workspace.events, index)) {
                  Text(transcriptDayLabel(event.ts || 0)).fontSize(12).lineHeight(13.2).fontColor(this.colors.muted)
                    .padding({ top: 6, bottom: 6, left: 10, right: 10 }).margin({ top: 14, bottom: 8 })
                    .border({ width: 1, color: this.colors.hairline }).borderRadius(this.colors.family === 'paper' ? 0 : 999).id('transcript-day')
                }
                Column() { this.bubble(event) }.margin({ top: transcriptGap(this.workspace.events, index) }).width('100%')
              }.width('100%')
            }
          }, (event: ChatEvent) => eventKey(event) + ':' + event.text)
          if (this.workspace.busy || this.workspace.activity.subagents > 0) {
            ListItem() {
              Column({ space: 6 }) {
                Text((this.workspace.busy ? '•••  ' : '') + this.workspace.activity.label(this.workspace.busy)).fontSize(13).fontColor(this.colors.muted)
                ForEach(this.workspace.activity.details.slice(0, this.workspace.activity.subagents), (detail: SubagentDetail) => { Text(subagentText(detail)).fontSize(12).fontColor(this.colors.muted).width('100%') }, (detail: SubagentDetail) => JSON.stringify(detail))
              }.alignItems(HorizontalAlign.Start).padding(14).constraintSize({ maxWidth: '82%' }).backgroundColor(this.colors.assistantBubble).borderRadius(this.colors.bubbleRadius)
            }
          }
        }.height('100%').width('100%').constraintSize({ maxWidth: 1000 }).padding({ left: 10, right: 10, top: 10, bottom: 10 })
          .onWillScroll((offset: number, state: ScrollState, source: ScrollSource) => {
            if (source === ScrollSource.DRAG || source === ScrollSource.FLING || source === ScrollSource.OTHER_USER_INPUT || source === ScrollSource.SCROLL_BAR || source === ScrollSource.SCROLL_BAR_FLING) {
              if (offset < 0) this.followingLatest = false;
            }
          })
          .onDidScroll((offset: number, state: ScrollState) => { if (offset > 0 && this.scroller.isAtEnd()) this.followingLatest = true; })
          .onAreaChange((_old: Area, area: Area) => { this.hintChatClip = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y), width: Number(area.width), height: Number(area.height) }; this.chatHeight = Number(area.height); this.chatWidth = Math.min(980, Number(area.width) - 20); this.followTail(); })
          .onScrollIndex((start: number) => { this.visibleMessageIndex = Math.max(0, start - (this.workspace.hasOlder ? 1 : 0)); })
        if (!this.followingLatest) {
          Row() { this.icon('down-bar', 'Latest messages', () => { this.run(async () => { this.followingLatest = true; await this.workspace.latest(); this.followTail(); }); }) }.padding(8).margin({ bottom: 8 }).backgroundColor(this.colors.paper).borderRadius(this.colors.cardRadius)
        }
        }.layoutWeight(1).width('100%')
        if (this.workspace.searchQuery) {
          Row({ space: 6 }) {
            Text(this.workspace.searchLoading ? 'Searching…' : (this.workspace.searchIndex < 0 ? 'No matches' : (this.workspace.searchBase + this.workspace.searchIndex + 1) + ' of ' + this.workspace.searchTotal)).fontSize(12).fontColor(this.colors.muted).layoutWeight(1)
            this.icon('up', 'Previous search match', () => { this.run(async () => { this.scrollToMessage(await this.workspace.stepSearch(-1)); }); })
            this.icon('chevronDown', 'Next search match', () => { this.run(async () => { this.scrollToMessage(await this.workspace.stepSearch(1)); }); })
            this.icon('x', 'Close search', () => { this.workspace.clearSearch(); })
          }.padding(10).width('100%')
        }
        Column({ space: 8 }) {
          if (!this.commandHidden && composerChoices(this.workspace.selected, this.workspace.launchDefaults, this.workspace.draft).length) {
            List({ scroller: this.commandScroller }) {
              ForEach(composerChoices(this.workspace.selected, this.workspace.launchDefaults, this.workspace.draft), (choice: ComposerChoice, index: number) => {
                ListItem() {
                  Column({ space: 3 }) {
                    Text(choice.title).fontSize(14).fontColor(this.colors.text).width('100%')
                    if (choice.description) { Text(choice.description).fontSize(12).fontColor(this.colors.muted).width('100%') }
                  }.padding(10).width('100%').backgroundColor(index === this.commandIndex ? this.colors.subtle : Color.Transparent).onClick(() => { this.run(() => this.workspace.chooseCommand(choice)); })
                }
              }, (choice: ComposerChoice) => choice.kind + ':' + choice.value)
            }.height(140).width('100%').backgroundColor(this.colors.paper).border({ width: 1, color: this.colors.hairline }).borderRadius(this.colors.cardRadius)
          }
          if (this.workspace.attachments.length) {
            Scroll() { Row({ space: 6 }) {
              ForEach(this.workspace.attachments, (item: Attachment) => {
                Row() { Text(item.display_name).fontSize(11).fontColor(this.colors.text).maxLines(1); this.icon('x', 'Remove attachment', () => { this.run(() => this.workspace.removeAttachment(item.id)); }) }.padding({ left: 10 }).borderRadius(this.colors.radius).backgroundColor(this.colors.subtle)
              }, (item: Attachment) => item.id)
            } }.width('100%').scrollable(ScrollDirection.Horizontal)
          }
          if (this.workspace.uploading) { Text('Uploading attachment…').fontSize(12).fontColor(this.colors.muted).width('100%') }
          if (this.workspace.unknownSend()) {
            this.button('Review uncertain send', () => { this.confirm({ title: 'Resolve uncertain send?', message: 'Check the transcript first. The previous message may already have been sent. Clearing this warning lets you submit again and may create a duplicate.', primaryButton: { value: 'Keep checking', action: () => {} }, secondaryButton: { value: 'Clear warning', action: () => { this.run(() => this.workspace.clearUnknownSend()); } } }); })
          }
          Row({ space: 6 }) {
            this.icon('paperclip', 'Attach files', () => { this.attachmentMenu(); }, false, () => !this.workspace.uploading, true)
            Column() {
            HintTarget({ label: 'Message', scope: 'chat', preferred: 'i', activate: () => { focusControl.requestFocus('message-input'); } }) {
            TextArea({ placeholder: 'Message', text: this.workspace.draft }).id('message-input').placeholderColor(this.colors.muted).width('100%').constraintSize({ minHeight: 40, maxHeight: 180 })
              .fontSize(16).fontColor(this.colors.text).backgroundColor(Color.Transparent).padding(10).borderRadius(0)
              // ArkUI requires explicit textOverflow for maxLines scrolling to take effect.
              .maxLines(7, { overflowMode: MaxLinesMode.SCROLL }).textOverflow(TextOverflow.Clip)
              .enterKeyType(EnterKeyType.NEW_LINE)
              .onChange((text: string, preview: PreviewText) => { this.composingText = !!preview.value; this.commandIndex = -1; this.commandHidden = false; this.workspace.setDraft(text); })
              .onFocus(() => { this.composerFocused = true; this.nativeHints.focus('message-input'); }).onBlur(() => { this.composerFocused = false; this.nativeHints.blur('message-input'); this.composerMeta = false; })
              .onKeyPreIme((event: KeyEvent): boolean => this.composerKey(event))
            }
            }.layoutWeight(1)
            Stack({ alignContent: Alignment.TopEnd }) {
              this.icon('queue', 'Queue', () => { this.open('queue'); }, false, () => true, true)
              if (this.workspace.activity.queue > 0) { Text('' + this.workspace.activity.queue).fontSize(10).fontColor(this.colors.onPrimary).backgroundColor(this.colors.primary).borderRadius(10).padding(3).hitTestBehavior(HitTestMode.None) }
            }
            this.icon('send', 'Send', () => { this.sendMessage(); }, true, () => !this.workspace.uploading && !this.workspace.sending)
          }.padding({ left: 10, right: 10, top: 6, bottom: 6 }).borderRadius(this.colors.family === 'slate' ? 24 : this.colors.bubbleRadius).border({ width: 1, color: this.colors.hairline }).backgroundColor(this.colors.paper)
        }.width('100%').padding({ left: 10, right: 10, top: 5, bottom: 5 })
      } else {
        Column({ space: 16 }) { Text('Select a session to continue').fontSize(16).fontColor(this.colors.muted); this.button('New session', () => { this.open('new'); }, true, 'chat') }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center)
      }
    }.id('chat-surface').focusable(true).onKeyEvent((event: KeyEvent) => this.chatKey(event)).height('100%').layoutWeight(1).backgroundColor(this.colors.background)
  }
  @Builder
  newSession() {
    Column({ space: 14 }) {
      Row({ space: 8 }) { ForEach(['codex', 'pi', 'cc'], (backend: string) => { this.button(backend === 'cc' ? 'Claude Code' : backend === 'pi' ? 'Pi' : 'Codex', () => { this.chooseBackend(backend); }, () => this.backend === backend) }) }
      this.field('Session name (optional)', () => this.newName, (value: string) => { this.newName = value; })
      this.field('Working directory', () => this.cwd, (value: string) => { this.cwd = value; this.scheduleLaunchContext(); })
      this.button('Choose directory', () => { this.directoryPicker = !this.directoryPicker; if (this.directoryPicker) this.run(() => this.launchContext.suggest(this.workspace.api, this.cwd, this.workspace.recentCwds)); })
      if (this.directoryPicker) {
        ForEach(this.launchContext.directories, (item: DirectoryChoice) => {
          Text(item.path).fontSize(12).fontFamily('monospace').fontColor(this.colors.text).padding(10).width('100%').backgroundColor(this.colors.subtle).onClick(() => { this.cwd = item.path; this.directoryPicker = false; this.scheduleLaunchContext(); })
        }, (item: DirectoryChoice) => item.path)
        if (!this.launchContext.directories.length) { Text('No matching directories').fontSize(12).fontColor(this.colors.muted) }
      }
      if (this.launchContext.loading) { Text('Checking directory…').fontSize(12).fontColor(this.colors.muted) }
      if (this.launchContext.error) { Text(this.launchContext.error).fontSize(12).fontColor(this.colors.danger).width('100%') }
      if (this.launchContext.info.will_create) { Text('Directory will be created when you start the session.').fontSize(12).fontColor(this.colors.muted) }
      if (this.launchContext.info.git_repo) { Text('Git branch: ' + (this.launchContext.info.git_branch || 'detached')).fontSize(12).fontColor(this.colors.muted) }
      if ((this.defaults().provider_choices || []).length) {
        HintTarget({ label: 'Provider', activate: () => { focusControl.requestFocus('launch-provider'); } }) {
ThemeDropdown({ colors: this.colors, options: this.defaults().provider_choices || [], controlId: 'launch-provider', label: 'Provider', value: this.provider, onSelect: (_index: number, value: string) => { this.provider = value; this.model = ''; this.rememberLaunchChoice(); } })
        }
      } else { this.field('Provider', () => this.provider, (value: string) => { this.provider = value; this.rememberLaunchChoice(); }) }
      if (this.modelOptions().length) { HintTarget({ label: 'Model choices', activate: () => { focusControl.requestFocus('launch-model'); } }) {
ThemeDropdown({ colors: this.colors, options: this.modelOptions(), controlId: 'launch-model', label: 'Model', value: this.model, placeholder: 'Default model', onSelect: (_index: number, value: string) => { this.model = value; this.rememberLaunchChoice(); } })
        } }
      this.field('Model', () => this.model, (value: string) => { this.model = value; this.rememberLaunchChoice(); })
      HintTarget({ label: 'Reasoning effort', activate: () => { focusControl.requestFocus('launch-effort'); } }) {
ThemeDropdown({ colors: this.colors, options: this.defaults().reasoning_efforts || [], controlId: 'launch-effort', label: 'Reasoning effort', value: this.effort, placeholder: 'Default effort', onSelect: (_index: number, value: string) => { this.effort = value; } })
        }
      if (this.defaults().supports_fast) { HintTarget({ label: 'Fast mode', activate: () => { this.fast = !this.fast; } }) { Row() { Text('Fast mode').fontSize(13).fontColor(this.colors.text).layoutWeight(1); Toggle({ type: ToggleType.Switch, isOn: this.fast }).attributeModifier(new ToggleTheme(this.colors, this.fast)).onChange((value: boolean) => { this.fast = value; }) }.width('100%') } }
      if (this.launchContext.candidates.length) {
        HintTarget({ label: 'Resume choices', activate: () => { focusControl.requestFocus('launch-resume'); } }) {
ThemeDropdown({ colors: this.colors, options: this.resumeOptions().map((option: SelectOption): string => option.value as string), controlId: 'launch-resume', label: 'Resume session',
          value: this.resumeId ? (this.launchContext.candidates.find((item: ResumeCandidate) => item.session_id === this.resumeId)?.alias || this.resumeId) : 'Start fresh',
          selectedIndex: this.resumeId ? this.launchContext.candidates.findIndex((item: ResumeCandidate) => item.session_id === this.resumeId) + 1 : 0,
          onSelect: (index: number) => { this.resumeId = index > 0 ? this.launchContext.candidates[index - 1].session_id : ''; this.branch = ''; } })
        }
      }
      this.field('Resume session ID', () => this.resumeId, (value: string) => { this.resumeId = value; })
      if (this.launchContext.info.git_repo && !this.resumeId) { this.field('New worktree branch', () => this.branch, (value: string) => { this.branch = value; }) }
      if (this.workspace.tmuxAvailable) { HintTarget({ label: 'Create in tmux', activate: () => { this.tmux = !this.tmux; } }) { Row() { Text('Create in tmux').fontSize(13).fontColor(this.colors.text).layoutWeight(1); Toggle({ type: ToggleType.Switch, isOn: this.tmux }).attributeModifier(new ToggleTheme(this.colors, this.tmux)).id('launch-tmux').onChange((value: boolean) => { this.tmux = value; }) }.width('100%') } }
      if (this.workspace.creating) { Text('Starting session…').fontSize(13).fontColor(this.colors.muted) }
      this.button('Create session', () => { this.run(async () => {
        const request: CreateSession = { name: this.newName.trim(), cwd: this.cwd, agent_backend: this.backend, model: this.model, model_provider: this.backend === 'codex' && (this.provider === 'chatgpt' || this.provider === 'openai-api') ? 'openai' : this.provider, preferred_auth_method: this.backend === 'codex' ? (this.provider === 'chatgpt' ? 'chatgpt' : 'apikey') : '', service_tier: this.fast ? 'fast' : '', reasoning_effort: this.effort, resume_session_id: this.resumeId, worktree_branch: this.resumeId ? '' : this.branch, create_in_tmux: this.tmux };
        await this.workspace.create(request);
      }); }, true)
    }.width('100%')
  }
  @Builder
  panelContent() {
    if (this.workspace.panel === 'new') { this.newSession() }
    else if (this.workspace.panel === 'unattended') {
      Column({ space: 14 }) {
        HintTarget({ label: 'Unattended mode', activate: () => { this.autoEnabled = !this.autoEnabled; } }) { Row() { Text('Unattended mode').fontSize(14).fontColor(this.colors.text).layoutWeight(1); Toggle({ type: ToggleType.Switch, isOn: this.autoEnabled }).attributeModifier(new ToggleTheme(this.colors, this.autoEnabled)).onChange((value: boolean) => { this.autoEnabled = value; }) }.width('100%') }
        HintTarget({ label: 'Continuation prompt', activate: () => { focusControl.requestFocus('unattended-request'); } }) {
        TextArea({ text: this.autoRequest, placeholder: 'Continuation prompt' }).placeholderColor(this.colors.muted).id('unattended-request').height(160).fontColor(this.colors.text).backgroundColor(this.colors.subtle).onChange((value: string) => { this.autoRequest = value; }).onFocus(() => { this.nativeHints.focus('unattended-request'); }).onBlur(() => { this.nativeHints.blur('unattended-request'); }).onKeyPreIme((event: KeyEvent): boolean => this.panelEntryKey(event))
        }
        this.field('Cooldown (minutes)', () => this.autoCooldown, (value: string) => { this.autoCooldown = value; })
        this.field('Remaining injections', () => this.autoRemaining, (value: string) => { this.autoRemaining = value; })
        this.button('Save', () => { this.run(async () => {
          const cooldown = Number(this.autoCooldown); const remaining = Number(this.autoRemaining);
          if (!Number.isInteger(cooldown) || cooldown < 1 || !Number.isInteger(remaining) || remaining < 0) throw new Error('Enter whole numbers: cooldown at least 1, remaining at least 0.');
          const config: UnattendedConfig = { enabled: this.autoEnabled, request: this.autoRequest, cooldown_minutes: cooldown, remaining_injections: remaining };
          await this.workspace.saveUnattended(config);
        }); }, true)
      }.width('100%')
    } else if (this.workspace.panel === 'queue-edit') {
      Column({ space: 12 }) {
        HintTarget({ label: 'Queued message', activate: () => { focusControl.requestFocus('queue-edit'); } }) {
        TextArea({ text: this.editText }).id('queue-edit').height(220).fontColor(this.colors.text).backgroundColor(this.colors.subtle).onChange((value: string) => { this.editText = value; }).onFocus(() => { this.nativeHints.focus('queue-edit'); }).onBlur(() => { this.nativeHints.blur('queue-edit'); }).onKeyPreIme((event: KeyEvent): boolean => this.panelEntryKey(event))
        }
        this.button('Save', () => { this.run(async () => { await this.workspace.changeQueue('update', { id: this.queueEditId, text: this.editText }); this.workspace.panel = 'queue'; }); }, true)
      }.width('100%')
    } else if (this.workspace.panel === 'queue') {
      Column({ space: 12 }) {
        this.button('Add draft to queue', () => { this.run(() => this.workspace.send(true)); }, true)
        ForEach(this.workspace.queue, (item: QueueItem, index: number) => {
          Column({ space: 8 }) {
            Text(item.text).fontSize(14).fontColor(this.colors.text).width('100%').copyOption(CopyOptions.LocalDevice)
            if (item.sending || item.commit_unknown || item.orphan_recovery) { Text(item.sending ? 'Sending' : item.commit_unknown ? 'Commit unknown' : 'Recovery').fontSize(12).fontColor(this.colors.danger) }
            Row() {
              this.icon('up', 'Move up', () => { if (index > 0) this.run(() => this.workspace.changeQueue('move', { id: item.id, to_index: index - 1 })); }, false, () => this.workspace.queueCanMove(index, index - 1))
              this.icon('down', 'Move down', () => { if (index + 1 < this.workspace.queue.length) this.run(() => this.workspace.changeQueue('move', { id: item.id, to_index: index + 1 })); }, false, () => this.workspace.queueCanMove(index, index + 1))
              this.icon('edit', 'Edit queued message', () => { this.queueEditId = item.id; this.editText = item.text; this.workspace.panel = 'queue-edit'; }, false, () => !this.workspace.queueLocked(item))
              Blank()
              this.icon('trash', 'Remove queued message', () => { this.removeQueued(item); }, false, () => !item.sending)
            }
          }.padding(12).borderRadius(this.colors.cardRadius).backgroundColor(this.colors.subtle).width('100%')
        }, (item: QueueItem) => JSON.stringify(item))
        if (!this.workspace.queue.length) { Text('Queue is empty.').fontSize(14).fontColor(this.colors.muted) }
      }.width('100%')
    } else if (this.workspace.panel === 'settings') {
      Column({ space: 16 }) {
        Text('Appearance').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.colors.text).width('100%')
        Row({ space: 8 }) { ForEach(['clay', 'slate', 'paper'], (family: string) => { this.button(family, () => { this.applyTheme(family, this.themeMode); }, () => this.colors.family === family) }) }
        Row({ space: 8 }) { ForEach(['system', 'light', 'dark'], (mode: string) => { this.button(mode, () => { this.applyTheme(this.colors.family, mode); }, () => this.themeMode === mode) }) }
        Text('Custom CSS').fontSize(13).fontColor(this.colors.text).width('100%')
        HintTarget({ label: 'Custom CSS', activate: () => { focusControl.requestFocus('custom-css'); } }) {
        TextArea({ text: this.customCss, placeholder: ':root { --accent: #c96442; }' }).id('custom-css').placeholderColor(this.colors.muted).height(130).fontSize(12).fontFamily('monospace').fontColor(this.colors.text).backgroundColor(this.colors.subtle)
          .onChange((value: string) => { this.customCss = value; this.applyTheme(this.colors.family, this.themeMode); }).onFocus(() => { this.nativeHints.focus('custom-css'); }).onBlur(() => { this.nativeHints.blur('custom-css'); }).onKeyPreIme((event: KeyEvent): boolean => this.panelEntryKey(event))
        }
        Text('Theme variables and .msg styles apply immediately. Unsupported rules appear below.').fontSize(12).fontColor(this.colors.muted).width('100%')
        if (this.cssWarnings) { Text(this.cssWarnings).fontSize(12).fontColor(this.colors.danger).width('100%') }
        Text('Voice & notifications').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.colors.text).width('100%')
        this.field('OpenAI-compatible API base URL', () => this.voiceUrl, (value: string) => { this.voiceUrl = value; })
        Text('OpenAI-compatible API key').fontSize(12).fontColor(this.colors.muted).width('100%')
        HintTarget({ label: 'API key', activate: () => { focusControl.requestFocus('voice-key'); } }) {
        TextInput({ text: this.voiceKey, placeholder: this.announcements.settings.has_tts_api_key ? 'Saved API key (leave blank to keep)' : 'Enter API key' }).id('voice-key').fontColor(this.colors.text).placeholderColor(this.colors.muted).backgroundColor(this.colors.subtle).type(InputType.Password).passwordIcon({ onIconSrc: $rawfile('icons/' + this.colors.mode + '/eye.svg'), offIconSrc: $rawfile('icons/' + this.colors.mode + '/eye-off.svg') }).height(44).onChange((value: string) => { this.voiceKey = value; }).onFocus(() => { this.nativeHints.focus('voice-key'); }).onBlur(() => { this.nativeHints.blur('voice-key'); }).onKeyPreIme((event: KeyEvent): boolean => this.panelEntryKey(event))
        }
        HintTarget({ label: 'Clear saved API key', activate: () => { this.voiceClearKey = !this.voiceClearKey; } }) { Row() { Text('Clear saved API key').fontSize(13).fontColor(this.colors.text).layoutWeight(1); Toggle({ type: ToggleType.Switch, isOn: this.voiceClearKey }).attributeModifier(new ToggleTheme(this.colors, this.voiceClearKey)).onChange((value: boolean) => { this.voiceClearKey = value; }) }.width('100%') }
        HintTarget({ label: 'Speak narration', activate: () => { this.voiceNarration = !this.voiceNarration; } }) { Row() { Text('Speak narration').fontSize(13).fontColor(this.colors.text).layoutWeight(1); Toggle({ type: ToggleType.Switch, isOn: this.voiceNarration }).attributeModifier(new ToggleTheme(this.colors, this.voiceNarration)).onChange((value: boolean) => { this.voiceNarration = value; }) }.width('100%') }
        Text('Unattended continuation prompt').fontSize(12).fontColor(this.colors.muted).width('100%')
        HintTarget({ label: 'Unattended continuation prompt', activate: () => { focusControl.requestFocus('global-unattended-prompt'); } }) {
        TextArea({ text: this.globalPrompt }).id('global-unattended-prompt').height(150).fontSize(13).fontColor(this.colors.text).backgroundColor(this.colors.subtle).onChange((value: string) => { this.globalPrompt = value; }).onFocus(() => { this.nativeHints.focus('global-unattended-prompt'); }).onBlur(() => { this.nativeHints.blur('global-unattended-prompt'); }).onKeyPreIme((event: KeyEvent): boolean => this.panelEntryKey(event))
        }
        this.button('Reset to built-in prompt', () => { this.globalPrompt = this.announcements.defaultPrompt; })
        Row({ space: 8 }) {
          this.button('Cancel', () => { this.voiceKey = ''; this.closePanel(); })
          this.button('Save', () => { this.run(async () => {
            const settings: VoiceWrite = { tts_base_url: this.voiceUrl, tts_api_key: this.voiceKey, tts_api_key_clear: this.voiceClearKey, tts_enabled_for_narration: this.voiceNarration, tts_enabled_for_final_response: true };
            await this.announcements.save(this.workspace.api, settings, this.globalPrompt); this.voiceKey = ''; this.workspace.notice = 'Settings saved'; this.workspace.panel = '';
          }); }, true)
        }
        Text('Enable notifications to receive session updates. Background delivery sends a device token and notification content through Huawei PushKit.').fontSize(12).fontColor(this.colors.muted).width('100%')
        this.button('Enable notifications', () => { this.run(() => this.announcements.setNotifications(this.workspace.api, true, getContext(this) as common.UIAbilityContext)); })
        if (this.announcements.notifications || this.announcements.notificationRegistration) { this.button('Disable notifications', () => { this.run(() => this.announcements.setNotifications(this.workspace.api, false, getContext(this) as common.UIAbilityContext)); }) }
        if (this.announcements.audioStatus) { Text(this.announcements.audioStatus).fontSize(12).fontColor(this.colors.muted).width('100%') }
        if (this.announcements.status) { Text(this.announcements.status).fontSize(12).fontColor(this.colors.muted).width('100%') }

      }.width('100%').alignItems(HorizontalAlign.Start)
    } else if (this.workspace.panel === 'search') {
      Column({ space: 12 }) {
        this.field('Search conversation', () => this.searchText, (value: string) => { this.searchText = value; })
        this.button('Search', () => { this.run(() => this.workspace.search(this.searchText)); }, true)
        Text(this.workspace.searchLoading ? 'Searching…' : this.workspace.searchTotal + ' matches').fontSize(12).fontColor(this.colors.muted)
        if (this.workspace.searchBase > 0) { this.button('Older matches', () => { this.run(() => this.workspace.search(this.workspace.searchQuery, true)); }) }
        ForEach(this.workspace.searchMatches, (match: SearchMatch) => {
          Column({ space: 6 }) {
            Text(match.role || '').fontSize(11).fontColor(this.colors.muted).width('100%')
            Text(match.snippet || match.text || '').fontSize(14).fontColor(this.colors.text).maxLines(6).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
          }.padding(12).backgroundColor(this.colors.subtle).width('100%').onClick(() => { this.run(async () => { this.scrollToMessage(await this.workspace.jump(match)); }); })
        })
      }.width('100%')
    } else if (this.workspace.panel === 'create-file') {
      Column({ space: 12 }) {
        this.field('New file path', () => this.editText, (value: string) => { this.editText = value; })
        this.button('Create', () => { this.run(() => this.workspace.createFile(this.editText)); }, true)
      }.width('100%')
    } else if (this.workspace.panel === 'recovery') {
      Column({ space: 12 }) {
        Text('Unsaved files on this device').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.colors.text)
        Text('Open a saved draft to continue editing. Saving still checks for changes on the server.').fontSize(13).fontColor(this.colors.muted)
        ForEach(this.workspace.recoveryFiles, (draft: FileDraft) => {
          this.button(draft.base.rel || draft.base.path, () => { this.workspace.recoverFile(draft); })
        }, (draft: FileDraft) => draft.key)
        if (!this.workspace.recoveryFiles.length) { Text('No unsaved files').fontColor(this.colors.muted) }
      }.width('100%')
    } else if (this.workspace.panel === 'files') {
      Column({ space: 8 }) {
        this.button('Recover unsaved files', () => { this.workspace.refreshRecovery(); this.workspace.panel = 'recovery'; })
        this.button('New file', () => { this.editText = ''; this.workspace.panel = 'create-file'; })
        this.button('Git changes', () => { this.run(() => this.workspace.loadGit()); })
        this.field('Search files', () => this.searchText, (value: string) => { this.searchText = value; })
        this.button('Search', () => { this.run(() => this.workspace.loadFiles(this.searchText)); })
        ForEach(this.workspace.files, (file: FileEntry) => { HintTarget({ label: file.path, activate: () => { this.run(() => this.workspace.openFile(file, this.filePickerLocation)); } }) { Text(file.path).fontSize(13).fontFamily('monospace').fontColor(this.colors.text).width('100%').padding(12).backgroundColor(this.colors.subtle).onClick(() => { this.run(() => this.workspace.openFile(file, this.filePickerLocation)); }) } }, (file: FileEntry) => file.path_token || file.path)
      }.width('100%')
    } else if (this.workspace.panel === 'git') {
      Column({ space: 8 }) {
        ForEach(this.workspace.gitFiles, (file: GitEntry) => {
          HintTarget({ label: file.path, activate: () => { this.run(() => file.untracked ? this.workspace.openFile(file) : this.workspace.openDiff(file)); } }) {
          Row({ space: 8 }) {
            Text(file.path).fontFamily('monospace').fontSize(13).fontColor(this.colors.text).layoutWeight(1)
            Text(file.untracked ? 'Untracked' : '+' + (file.additions ?? '?') + ' −' + (file.deletions ?? '?')).fontSize(12).fontColor(this.colors.muted)
          }.width('100%').padding(12).backgroundColor(this.colors.subtle).onClick(() => { this.run(() => file.untracked ? this.workspace.openFile(file) : this.workspace.openDiff(file)); })
          }
        }, (file: GitEntry) => file.path_token || file.path)
        if (!this.workspace.gitFiles.length) { Text('No changes').fontColor(this.colors.muted) }
      }.width('100%')
    } else if (this.workspace.panel === 'diff') {
      Column({ space: 4 }) {
        Text(this.workspace.gitPath).fontSize(13).fontColor(this.colors.text).width('100%')
        ForEach(this.workspace.gitDiff.split('\n'), (line: string) => {
          Text(line || ' ').fontFamily('monospace').fontSize(12).lineHeight(19).width('100%').copyOption(CopyOptions.LocalDevice)
            .fontColor(line.startsWith('+') ? (this.colors.mode === 'dark' ? '#a8c79b' : '#426b3d') : line.startsWith('-') ? this.colors.danger : this.colors.text)
            .backgroundColor(line.startsWith('+') || line.startsWith('-') ? this.colors.subtle : Color.Transparent)
        })
      }.width('100%')
    } else if (this.workspace.panel === 'file') {
      Column({ space: 8 }) {
        if (!this.fileFull) {
        Row({ space: 6 }) {
        Scroll() {
          Row({ space: 8 }) {
            ForEach(this.workspace.fileTabs, (tab: FileTab) => {
              this.fileTab(() => ((tab.content.rel || tab.content.path).split('/').pop() || tab.key) + ((this.workspace.activeFile && this.workspace.fileKey(this.workspace.activeFile) === tab.key ? this.workspace.fileDirty : (this.workspace.fileTabs.find((item: FileTab) => item.key === tab.key)?.dirty || false)) ? ' •' : ''), () => { this.workspace.switchFile(tab.key); }, () => this.workspace.activeFile !== undefined && this.workspace.fileKey(this.workspace.activeFile) === tab.key)
            }, (tab: FileTab) => tab.key)
          }
        }.id('file-tabs').scrollable(ScrollDirection.Horizontal).align(Alignment.Start).layoutWeight(1)
          this.icon('file', 'Browse', () => { this.workspace.stashFile(); this.workspace.panel = 'files'; this.run(() => this.workspace.loadFiles()); })
          this.icon('refresh', 'Reload', () => {
            const reload = (): void => { this.run(() => this.workspace.reloadFile()); };
            if (this.workspace.fileDirty) this.confirm({ title: 'Reload from server?', message: 'This replaces your unsaved changes.', primaryButton: { value: 'Keep editing', action: () => {} }, secondaryButton: { value: 'Reload', action: reload } });
            else reload();
          })
          this.icon('trash', 'Close file', () => {
            const file = this.workspace.activeFile; if (!file) return;
            const key = this.workspace.fileKey(file);
            if (this.workspace.fileDirty) this.confirm({ title: 'Discard unsaved changes?', message: 'Closing this file discards its unsaved changes.', primaryButton: { value: 'Keep editing', action: () => {} }, secondaryButton: { value: 'Discard', action: () => { this.workspace.closeFile(key); } } });
            else this.workspace.closeFile(key);
          })
        }.width('100%')
        }
        Text(this.workspace.activeFile?.rel || '').fontSize(12).fontFamily('monospace').fontColor(this.colors.muted).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
        Column() {
        if (this.workspace.activeFile?.kind === 'image' && this.workspace.localMedia) {
          ImageViewer({ path: this.workspace.localMedia, colors: this.colors, contentHeight: this.fileBodyHeight })
        } else if (this.workspace.activeFile?.kind === 'pdf' && this.workspace.localMedia) {
          ForEach([this.workspace.fileKey(this.workspace.activeFile)], (_key: string) => { PdfReader({ path: this.workspace.localMedia, colors: this.colors, contentHeight: this.fileBodyHeight }) }, (key: string) => key)
        } else if (this.workspace.activeFile?.kind === 'video' && this.workspace.localMedia) {
          VideoViewer({ path: this.workspace.localMedia, colors: this.colors, contentHeight: this.fileBodyHeight })
        } else if (this.workspace.activeFile?.kind === 'text' || this.workspace.activeFile?.kind === 'markdown') {
          ForEach([this.workspace.fileKey(this.workspace.activeFile)], (_key: string) => { CodeEditor({ workspace: this.workspace, colors: this.colors, location: this.workspace.fileLocation, contentHeight: this.fileBodyHeight, onSave: () => { this.run(() => this.workspace.saveFile()); }, onLink: (url: string) => { this.link(url); }, onCopy: (text: string) => { this.copy(text); } }) }, (key: string) => key)
        } else if (this.workspace.activeFile?.kind === 'download_only') { Text(this.workspace.activeFile.reason === 'too_large' ? 'This file is too large to preview. Use Download to save the complete file.' : 'This binary file is available for download.').fontSize(14).fontColor(this.colors.muted).width('100%') }
        else { Text('Loading preview…').fontColor(this.colors.muted) }

        }.width('100%').layoutWeight(1).onAreaChange((_old: Area, area: Area) => { this.fileBodyHeight = Math.max(100, Number(area.height)); })
      }.width('100%').height('100%')
    } else if (this.workspace.panel === 'rename') {
      Column({ space: 12 }) {
        this.field('Session name', () => this.editText, (value: string) => { this.editText = value; })
        Text('Priority adjustment: ' + this.priority.toFixed(2)).fontSize(13).fontColor(this.colors.text).width('100%')
        Slider({ value: this.priority, min: -1, max: 1, step: 0.05 }).trackColor(this.colors.hairline).selectedColor(this.colors.primary).blockColor(this.colors.primary).width('100%').onChange((value: number) => { this.priority = value; })
        this.button('Reset priority', () => { this.priority = 0; })
        HintTarget({ label: 'Snooze', activate: () => { focusControl.requestFocus('session-snooze'); } }) {
ThemeDropdown({ colors: this.colors, options: ['No snooze', '4 hours', 'Tomorrow', 'Custom'], controlId: 'session-snooze', label: 'Snooze',
          value: this.snoozeMode === '4h' ? '4 hours' : this.snoozeMode === 'tomorrow' ? 'Tomorrow' : this.snoozeMode === 'custom' ? 'Custom' : 'No snooze',
          onSelect: (index: number) => { this.snoozeMode = ['none', '4h', 'tomorrow', 'custom'][index]; } })
        }
        if (this.snoozeMode === 'custom') {
          this.field('Snooze date (YYYY-MM-DD)', () => this.snoozeDate, (value: string) => { this.snoozeDate = value; })
          this.field('Snooze time (HH:mm)', () => this.snoozeTime, (value: string) => { this.snoozeTime = value; })
        }
        Text('Wait for session').fontSize(13).fontColor(this.colors.text).width('100%')
        HintTarget({ label: 'Wait for session', activate: () => { focusControl.requestFocus('session-dependency'); } }) {
ThemeDropdown({ colors: this.colors, options: ['None'].concat(this.workspace.sessions.filter((row: Session) => row.session_id !== this.editSession?.session_id).map((row: Session): string => sessionName(row))), controlId: 'session-dependency', label: 'Wait for session',
          value: this.dependency ? sessionName(this.workspace.sessions.find((row: Session) => row.session_id === this.dependency) || { session_id: this.dependency }) : 'None',
          selectedIndex: this.dependency ? this.workspace.sessions.filter((row: Session) => row.session_id !== this.editSession?.session_id).findIndex((row: Session) => row.session_id === this.dependency) + 1 : 0,
          onSelect: (index: number) => { this.dependency = index > 0 ? this.workspace.sessions.filter((row: Session) => row.session_id !== this.editSession?.session_id)[index - 1].session_id : ''; } })
        }
        this.button('Save', () => { if (this.editSession) this.run(async () => {
          this.snoozeUntil = this.snoozeMode === '4h' ? Math.floor(Date.now() / 1000) + 4 * 3600 : this.snoozeMode === 'tomorrow' ? tomorrowMorning() : null;
          if (this.snoozeMode === 'custom') {
            this.snoozeUntil = customSnooze(this.snoozeDate, this.snoozeTime);
          }
          const body: SessionEdit = { name: this.editText, priority_offset: this.priority, snooze_until: this.snoozeUntil, dependency_session_id: this.dependency || null };
          await this.workspace.action('edit', JSON.stringify(body), this.editSession!.session_id); this.workspace.panel = '';
        }); }, true)
      }.width('100%')
    } else if (this.workspace.panel === 'details') {
      if (sessionDiagnostics(this.workspace.details)) {
        ForEach([this.workspace.selected?.session_id || ''], (_id: string) => { SessionDetails({ workspace: this.workspace, colors: this.colors, onCopy: () => { this.copyConversation(); } }) }, (id: string) => id)
      } else { Text(this.workspace.details).fontSize(14).fontColor(this.colors.text).width('100%') }
    }
    else if (this.workspace.panel === 'help') {
      HelpContent({ colors: this.colors })
    }
  }
  @Builder
  panel() {
    Column() {
      Row({ space: 6 }) {
        Text(this.workspace.panel === 'file' ? 'View file' : this.workspace.panel === 'new' ? 'New session' : this.workspace.panel.charAt(0).toUpperCase() + this.workspace.panel.slice(1)).fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.colors.text).layoutWeight(1)
        if (this.workspace.panel === 'file') {
          this.icon('select', () => this.fileFull ? 'Exit full screen' : 'Full screen', () => { this.fileFull = !this.fileFull; })
          this.icon('download', 'Download', () => { this.downloadFile(); })
        }
        if (this.workspace.panel === 'file' && this.workspace.activeFile?.editable) { this.icon('save', 'Save', () => { this.run(() => this.workspace.saveFile()); }, () => this.workspace.fileDirty) }
        this.icon('x', 'Close', () => { this.closePanel(); })
      }.height(this.workspace.panel === 'file' ? 48 : 60).padding({ left: this.workspace.panel === 'file' ? 12 : 20, right: 12 }).width('100%').border({ width: { bottom: 1 }, color: this.colors.hairline })
      if (this.workspace.error) { Text(this.workspace.error).fontSize(12).fontColor(this.colors.danger).padding(16).width('100%') }
      if (this.workspace.panel === 'file') {
        Column() { this.panelContent() }.padding(12).width('100%').layoutWeight(1)
      } else { Scroll() { Column() { this.panelContent() }.width('100%').padding(20) }.align(Alignment.Top).layoutWeight(1).width('100%') }
    }.onKeyEvent((event: KeyEvent) => { if (this.hintKey(event) || (event.type === KeyType.Down && event.keyCode === 2070)) event.stopPropagation(); }).width(this.fileFull && this.workspace.panel === 'file' ? '100%' : this.viewportWidth >= (this.foldStatus !== 0 && this.foldStatus !== 2 ? 680 : 840) ? (this.workspace.panel === 'file' ? Math.min(this.viewportWidth * 0.92, 960) : 520) : '100%').height(this.fileFull && this.workspace.panel === 'file' ? '100%' : this.viewportWidth >= (this.foldStatus !== 0 && this.foldStatus !== 2 ? 680 : 840) ? '88%' : '100%').backgroundColor(this.colors.paper)
      .borderRadius(this.viewportWidth >= (this.foldStatus !== 0 && this.foldStatus !== 2 ? 680 : 840) ? this.colors.cardRadius : 0).border({ width: 1, color: this.colors.hairline })
  }
  build() {
    Stack({ alignContent: Alignment.Center }) {
      if (!this.workspace.authenticated) { this.login() }
      else {
        Row() { if (this.viewportWidth >= (this.foldStatus !== 0 && this.foldStatus !== 2 ? 680 : 840)) { this.sidebar() }
this.conversation() }.width('100%').height('100%').enabled(!this.workspace.panel).accessibilityLevel(this.workspace.panel ? 'no-hide-descendants' : 'auto')
        if (this.workspace.sidebar && this.viewportWidth < (this.foldStatus !== 0 && this.foldStatus !== 2 ? 680 : 840)) { Row() { this.sidebar(); Blank().height('100%').onClick(() => { this.workspace.sidebar = false; }) }.width('100%').height('100%').backgroundColor(Color.Transparent) }
        if (this.workspace.panel) { Stack() { this.panel() }.width('100%').height('100%').backgroundColor(Color.Transparent) }
      }
      ForEach(this.nativeHints.badges, (badge: HintBadge) => { Text(badge.label).id('hint-' + badge.label).accessibilityText(badge.label + ': ' + badge.target).accessibilityDescription(badge.target).fontFamily('monospace').fontSize(14).fontWeight(FontWeight.Bold).fontColor('#ffffff').backgroundColor('#141111').padding({ left: 4, right: 4, top: 1, bottom: 1 }).position({ x: badge.x, y: badge.y }).hitTestBehavior(HitTestMode.None) }, (badge: HintBadge) => '' + badge.id)
    }.onTouch((event: TouchEvent) => { if (event.type === TouchType.Down) this.nativeHints.exit(); }).onKeyEvent((event: KeyEvent) => { if (this.hintKey(event)) event.stopPropagation(); }).width('100%').height('100%').backgroundColor(this.colors.background).onAreaChange((_old: Area, area: Area) => { this.hintViewport = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y), width: Number(area.width), height: Number(area.height) }; this.nativeHints.exit(); this.viewportHeight = Number(area.height); if (this.viewportWidth !== Number(area.width)) { this.viewportWidth = Number(area.width); if (this.customCss) this.applyTheme(this.colors.family, this.themeMode, false); } })
  }
}
