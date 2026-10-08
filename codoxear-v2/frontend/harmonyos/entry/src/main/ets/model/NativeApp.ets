import { HubAccounts, HubAccount, NativeComputer, SecureVault, NativeIdentityPlatform } from '../services/HubAccounts';
import { HubPush, InstallationPush, NotificationTarget } from '../services/HubPush';
import { SavedLogin } from '../services/SavedLogin';
import { Workspace } from './Workspace';
@Observed
export class NativeApp {
  readonly accounts: HubAccounts;
  readonly push: HubPush;
  readonly workspace: Workspace = new Workspace();
  readonly direct: SavedLogin = new SavedLogin();
  computers: NativeComputer[] = [];
  selectedComputer: NativeComputer | undefined = undefined;
  panel: boolean = false;
  error: string = '';
  onChanged: () => void = () => {};
  private generation: number = 0;
  constructor(vault: SecureVault, platform: NativeIdentityPlatform, provider: InstallationPush, installationId: string) {
    this.accounts = new HubAccounts(vault, platform, installationId);
    this.push = new HubPush(this.accounts, vault, provider, installationId);
    this.accounts.onChanged = () => this.onChanged();
    this.accounts.onDeselected = () => {
      this.generation++; this.selectedComputer = undefined; this.computers = [];
      if (this.workspace.authenticated) void this.workspace.logout().catch(error => this.report(error));
      else { this.workspace.api.invalidate(); this.workspace.dispose(); }
      this.onChanged();
    };
    this.push.onChanged = () => this.onChanged(); this.push.onError = message => { this.error = message; this.onChanged(); };
    this.workspace.onTranscriptChanged = () => this.onChanged();
    this.workspace.onAuthenticationLost = () => { this.selectedComputer = undefined; this.panel = true; this.onChanged(); };
  }
  private report(error: Error): void { this.error = error.message || String(error); this.onChanged(); }
  async initialize(directory: string): Promise<void> {
    this.workspace.storageDir = directory;
    await this.accounts.restore(); await this.push.restore(); this.onChanged();
  }
  async callback(value: string): Promise<void> {
    try { const key = await this.accounts.finish(value); await this.chooseAccount(key); this.panel = true; }
    catch (error) { this.report(error as Error); this.panel = true; }
    this.onChanged();
  }
  async chooseAccount(key: string): Promise<void> {
    this.accounts.select(key); const generation = this.generation;
    try { const computers = await this.accounts.computers(key); if (generation !== this.generation) return; this.computers = computers; }
    catch (error) { if (generation === this.generation) this.report(error as Error); }
    this.onChanged();
  }
  async chooseComputer(computer: NativeComputer): Promise<void> {
    const key = this.accounts.selected, generation = ++this.generation;
    const account = this.accounts.accounts.find((a: HubAccount) => a.key === key);
    if (!account) throw new Error('Choose a Hub account.');
    const token = await this.accounts.token(key);
    const current = (await this.accounts.computers(key)).find(c => c.id === computer.id && c.binding === computer.binding);
    if (!current || generation !== this.generation || this.accounts.selected !== key) throw new Error('Computer access changed. Choose again.');
    await this.workspace.connectRelay({ endpoint: account.origin, issuer: account.origin, accountId: account.accountId,
      hubId: account.hubId, computerId: current.id, accessToken: token,
      tokenProvider: async () => {
        if (generation !== this.generation || this.accounts.selected !== key) throw new Error('Connection changed.');
        const fresh = await this.accounts.token(key);
        if (generation !== this.generation || this.accounts.selected !== key) throw new Error('Connection changed.'); return fresh;
      } });
    if (generation !== this.generation) return;
    this.selectedComputer = current; this.panel = false; this.onChanged();
  }
  async connectDirect(origin: string, password: string, save: boolean): Promise<void> {
    this.accounts.lock(); const generation = this.generation;
    await this.workspace.login(origin, password);
    if (generation !== this.generation) return;
    if (save) await this.direct.save(origin, password); this.panel = false; this.onChanged();
  }
  async openNotification(target: NotificationTarget): Promise<void> {
    try {
      const allowed = await this.push.authorizeTarget(target);
      await this.chooseAccount(allowed.accountKey); await this.chooseComputer(allowed.computer);
      await this.workspace.openNotification(target.server, target.localId);
    } catch (error) { this.report(error as Error); this.panel = true; }
    this.onChanged();
  }
  background(): void { this.accounts.lock(); }
  async foreground(): Promise<void> {
    await this.accounts.restore(); await this.push.restore();
    if (this.push.registrations.some(r => r.enabled)) await this.push.refresh().catch(error => this.report(error as Error));
  }
  dispose(): void { this.push.dispose(); this.accounts.lock(); this.workspace.dispose(); }
}
