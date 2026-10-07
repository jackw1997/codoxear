import { HubAccounts, SecureVault, NativeComputer } from './HubAccounts';
export interface InstallationPush {
  getToken(): Promise<string>;
  deleteToken(): Promise<void>;
  watch(updated: (token: string) => void): () => void;
}
export interface HubRegistration { key: string; accountKey: string; computerId: string; binding: number; enabled: boolean; }
export interface NotificationTarget { server: string; computerId: string; hubId: string; localId: string; }
@Observed
export class HubPush {
  registrations: HubRegistration[] = [];
  onChanged: () => void = () => {};
  onError: (message: string) => void = () => {};
  private work: Promise<void> = Promise.resolve();
  private stop: (() => void) | undefined = undefined;
  constructor(readonly accounts: HubAccounts, readonly vault: SecureVault,
    readonly provider: InstallationPush, readonly installationId: string) {
    accounts.beforeLogout = (key: string) => this.removeAccount(key);
  }
  private serialized(operation: () => Promise<void>): Promise<void> {
    const next = this.work.catch(() => {}).then(operation); this.work = next; return next;
  }
  private async persist(row: HubRegistration): Promise<void> {
    await this.vault.write('push:' + row.key, JSON.stringify(row));
    await this.vault.write('push-index', JSON.stringify(this.registrations.map((r: HubRegistration) => r.key)));
    this.onChanged();
  }
  async restore(): Promise<void> {
    await this.serialized(async () => {
      const value = await this.vault.read('push-index'), rows: HubRegistration[] = [];
      for (const key of value ? JSON.parse(value) as string[] : []) {
        const stored = await this.vault.read('push:' + key);
        if (stored) {
          const row = JSON.parse(stored) as HubRegistration;
          if (row.key === key && this.accounts.accounts.some(a => a.key === row.accountKey)) rows.push(row);
        }
      }
      this.registrations = rows; this.onChanged();
      this.stop?.(); this.stop = this.provider.watch(token => { void this.updateToken(token).catch(error => this.onError(String(error))); });
    });
  }
  private async upload(row: HubRegistration, token: string): Promise<void> {
    const computers = await this.accounts.computers(row.accountKey);
    if (!computers.some((c: NativeComputer) => c.id === row.computerId && c.binding === row.binding)) throw new Error('Computer binding changed; review notification access again.');
    await this.accounts.request(row.accountKey, '/api/v1/push/subscriptions', 'POST', JSON.stringify({
      provider: 'harmony', computerId: row.computerId, installationId: this.installationId, token }));
  }
  enable(accountKey: string, computer: NativeComputer): Promise<void> {
    return this.serialized(async () => {
      const key = await this.accounts.platform.sha256(accountKey + '\u0000' + computer.id);
      if (!this.registrations.some(r => r.key === key) && this.registrations.length >= 16) throw new Error('Remove a notification registration before adding another.');
      const row: HubRegistration = { key, accountKey, computerId: computer.id, binding: computer.binding, enabled: true };
      const token = await this.provider.getToken();
      await this.vault.write('push-token', token);
      this.registrations = [...this.registrations.filter(r => r.key !== key), row];
      await this.persist(row); // Lost POST results retain an installation/account-specific removal target.
      await this.upload(row, token);
    });
  }
  updateToken(token: string): Promise<void> {
    return this.serialized(async () => {
      if (!token) throw new Error('Push token is empty.');
      await this.vault.write('push-token', token);
      const failures: string[] = [];
      for (const row of this.registrations.filter(r => r.enabled)) {
        try { await this.upload(row, token); }
        catch (error) { failures.push(row.accountKey + ': ' + String(error)); }
      }
      if (failures.length) throw new Error(failures.join('\n'));
    });
  }
  async refresh(): Promise<void> { await this.updateToken(await this.provider.getToken()); }
  private async remove(row: HubRegistration): Promise<void> {
    row.enabled = false; await this.persist(row);
    await this.accounts.request(row.accountKey, '/api/v1/push/subscriptions/' + encodeURIComponent(this.installationId) + '/' + encodeURIComponent(row.computerId), 'DELETE').catch(error => this.onError('Hub notification cleanup requires a connection: ' + String(error)));
    this.registrations = this.registrations.filter(r => r.key !== row.key);
    await this.vault.remove('push:' + row.key);
    await this.vault.write('push-index', JSON.stringify(this.registrations.map(r => r.key)));
    if (!this.registrations.some(r => r.enabled)) { await this.provider.deleteToken(); await this.vault.remove('push-token'); }
    this.onChanged();
  }
  disable(key: string): Promise<void> { return this.serialized(async () => { const row = this.registrations.find(r => r.key === key); if (row) await this.remove(row); }); }
  removeAccount(key: string): Promise<void> { return this.serialized(async () => { for (const row of [...this.registrations].filter(r => r.accountKey === key)) await this.remove(row); }); }
  async authorizeTarget(target: NotificationTarget): Promise<{ accountKey: string; computer: NativeComputer }> {
    const scope = JSON.parse(target.server) as string[];
    if (scope.length !== 5 || scope[0] !== 'relay-v1' || scope[3] !== target.hubId || scope[4] !== target.computerId) throw new Error('Notification belongs to another connection.');
    const account = this.accounts.accounts.find(a => a.origin === scope[1] && a.accountId === scope[2] && a.hubId === target.hubId);
    const row = this.registrations.find(r => r.enabled && r.accountKey === account?.key && r.computerId === target.computerId);
    if (!account || !row) throw new Error('Notification account was removed from this device.');
    const computer = (await this.accounts.computers(account.key)).find(c => c.id === row.computerId && c.binding === row.binding);
    if (!computer) throw new Error('Notification Computer access changed.');
    const agent = (await this.accounts.agents(account.key)).find(a => a.computerId === computer.id && a.hubId === target.hubId && a.localId === target.localId);
    if (!agent) throw new Error('Notification agent access changed.');
    await this.accounts.request(account.key, '/api/agents/' + encodeURIComponent(agent.id) + '/access');
    return { accountKey: account.key, computer };
  }
  dispose(): void { this.stop?.(); this.stop = undefined; }
}
