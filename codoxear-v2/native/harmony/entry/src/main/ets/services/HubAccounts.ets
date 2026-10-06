export interface SecureVault {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface Callback { base: string; state: string; code: string; issuer: string; error: string; }
export interface NativeIdentityPlatform {
  random(): string;
  sha256(value: string): Promise<string>;
  callback(value: string): Callback;
  openBrowser(value: string): Promise<void>;
  json<T>(origin: string, path: string, method: string, body: string, token: string): Promise<T>;
  now(): number;
}
export interface HubAccount { key: string; origin: string; accountId: string; name: string; hubId: string; }
interface SavedAccount extends HubAccount { refreshToken: string; }
interface Tokens { access_token: string; refresh_token: string; expires_in: number; }
interface Access { token: string; expires: number; }
interface PendingLogin { origin: string; state: string; verifier: string; expires: number; }
interface Me { id: string; name: string; }
interface Hub { id: string; origin: string; access: string; }
export interface NativeComputer { id: string; name: string; binding: number; }
export interface NativeAgent { id: string; hubId: string; computerId: string; localId: string | null; access: string; }

// Each independent Hub is an issuer. The presenter never requests a global account.
@Observed
export class HubAccounts {
  accounts: HubAccount[] = [];
  selected: string = '';
  pending: boolean = false;
  onChanged: () => void = () => {};
  onDeselected: () => void = () => {};
  beforeLogout: (key: string) => Promise<void> = async () => {};
  private epoch: number = 0;
  private privacyEpoch: number = 0;
  private work: Promise<void> = Promise.resolve();
  private access: Map<string, Access> = new Map();
  private rotations: Map<string, Promise<string>> = new Map();
  private scoped: Map<string, Access> = new Map();
  private scoping: Map<string, Promise<string>> = new Map();
  constructor(readonly vault: SecureVault, readonly platform: NativeIdentityPlatform,
    readonly installationId: string, readonly clientId: string = 'codoxear-harmony',
    readonly redirectUri: string = 'codoxear-v2://oauth/callback') {}
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.work.catch(() => {}).then(operation);
    this.work = next.then(() => {}, () => {}); return next;
  }
  private origin(value: string): string {
    if (!/^https:\/\/[^\s/?#@:]+(?::[0-9]+)?$/.test(value) || value.length > 180)
      throw new Error('Enter an exact HTTPS Hub origin.');
    return value;
  }
  private account(key: string): HubAccount {
    const row = this.accounts.find((a: HubAccount) => a.key === key);
    if (!row) throw new Error('Sign in to this Hub account.'); return row;
  }
  async restore(): Promise<void> {
    await this.serialized(async () => {
      const index = await this.vault.read('hub-accounts');
      const keys = index ? JSON.parse(index) as string[] : [];
      const rows: HubAccount[] = [];
      for (const key of keys) {
        const value = await this.vault.read('account:' + key);
        if (!value) continue;
        const row = JSON.parse(value) as SavedAccount;
        this.origin(row.origin);
        if (row.key !== key || !row.refreshToken) throw new Error('Saved Hub account is invalid.');
        rows.push({ key: row.key, origin: row.origin, accountId: row.accountId, name: row.name, hubId: row.hubId });
      }
      this.accounts = rows;
      const pending = await this.vault.read('hub-login');
      this.pending = !!pending && (JSON.parse(pending) as PendingLogin).expires > this.platform.now();
      if (pending && !this.pending) await this.vault.remove('hub-login');
      this.onChanged();
    });
  }
  async begin(origin: string): Promise<void> {
    origin = this.origin(origin);
    const epoch = ++this.epoch; this.selected = ''; this.onDeselected();
    await this.serialized(async () => {
      if (epoch !== this.epoch) throw new Error('Sign-in was cancelled.');
      const flow: PendingLogin = { origin, state: this.platform.random(), verifier: this.platform.random(), expires: this.platform.now() + 600000 };
      await this.vault.write('hub-login', JSON.stringify(flow));
      const challenge = await this.platform.sha256(flow.verifier);
      if (epoch !== this.epoch) { await this.vault.remove('hub-login'); throw new Error('Sign-in was cancelled.'); }
      this.pending = true; this.onChanged();
      const query = 'response_type=code&client_id=' + encodeURIComponent(this.clientId) + '&redirect_uri=' + encodeURIComponent(this.redirectUri) +
        '&code_challenge_method=S256&code_challenge=' + challenge + '&state=' + flow.state;
      try { await this.platform.openBrowser(origin + '/oauth/authorize?' + query); }
      catch (error) { this.pending = false; await this.vault.remove('hub-login'); this.onChanged(); throw error; }
    });
  }
  async cancel(): Promise<void> {
    this.epoch++; this.pending = false; this.onChanged();
    await this.serialized(() => this.vault.remove('hub-login'));
  }
  finish(callback: string): Promise<string> {
    const epoch = this.epoch;
    return this.serialized(async () => {
      const parsed = this.platform.callback(callback);
      if (parsed.base !== this.redirectUri) throw new Error('Callback does not belong to this application.');
      const stored = await this.vault.read('hub-login');
      const flow = stored ? JSON.parse(stored) as PendingLogin : undefined;
      if (!flow || parsed.state !== flow.state || parsed.issuer !== flow.origin || flow.expires <= this.platform.now()) throw new Error('Sign-in expired or belongs to another Hub.');
      await this.vault.remove('hub-login'); this.pending = false; this.onChanged();
      if (parsed.error || !parsed.code) throw new Error('Sign-in was cancelled.');
      const tokens = await this.platform.json<Tokens>(flow.origin, '/oauth/token', 'POST', JSON.stringify({ grant_type: 'authorization_code',
        code: parsed.code, client_id: this.clientId, installation_id: this.installationId, redirect_uri: this.redirectUri, code_verifier: flow.verifier }), '');
      const me = await this.platform.json<Me>(flow.origin, '/api/v1/me', 'GET', '', tokens.access_token);
      const hubs = await this.platform.json<Hub[]>(flow.origin, '/api/v1/me/hubs', 'GET', '', tokens.access_token);
      const hub = hubs.find((h: Hub) => h.origin === flow.origin && h.access === 'allowed');
      if (!hub) throw new Error('This Hub did not authorize its own account.');
      const key = await this.platform.sha256(flow.origin + '\u0000' + me.id);
      const account: SavedAccount = { key, origin: flow.origin, accountId: me.id, name: me.name || me.id, hubId: hub.id, refreshToken: tokens.refresh_token };
      if (epoch !== this.epoch) { await this.platform.json(flow.origin, '/oauth/revoke', 'POST', JSON.stringify({ token: tokens.refresh_token }), '').catch(() => {}); throw new Error('Sign-in was cancelled.'); }
      if (!this.accounts.some((a: HubAccount) => a.key === key) && this.accounts.length >= 16) throw new Error('Remove an account before adding another.');
      await this.vault.write('account:' + key, JSON.stringify(account));
      if (epoch !== this.epoch) { await this.vault.remove('account:' + key); throw new Error('Sign-in was cancelled.'); }
      this.accounts = [...this.accounts.filter((a: HubAccount) => a.key !== key), { key, origin: account.origin, accountId: me.id, name: account.name, hubId: hub.id }];
      await this.vault.write('hub-accounts', JSON.stringify(this.accounts.map((a: HubAccount) => a.key)));
      this.access.set(key, { token: tokens.access_token, expires: this.platform.now() + tokens.expires_in * 1000 });
      this.selected = key; this.onChanged(); return key;
    });
  }
  select(key: string): void { this.account(key); this.epoch++; this.selected = key; this.onDeselected(); this.onChanged(); }
  private async identityToken(key: string): Promise<string> {
    const cached = this.access.get(key);
    if (cached && cached.expires > this.platform.now() + 30000) return cached.token;
    const existing = this.rotations.get(key); if (existing) return existing;
    const operation = (async (): Promise<string> => {
      const row = this.account(key), stored = await this.vault.read('account:' + key);
      if (!stored) throw new Error('Sign in to this Hub again.');
      const before = JSON.parse(stored) as SavedAccount;
      if (!before.refreshToken) throw new Error('Sign in to this Hub again.');
      const privacyEpoch = this.privacyEpoch;
      let attempted = false;
      try {
        await this.vault.write('account:' + key, JSON.stringify({ ...before, refreshToken: '' }));
        attempted = true;
        const tokens = await this.platform.json<Tokens>(row.origin, '/oauth/token', 'POST', JSON.stringify({ grant_type: 'refresh_token', refresh_token: before.refreshToken }), '');
        await this.vault.write('account:' + key, JSON.stringify({ ...before, refreshToken: tokens.refresh_token }));
        if (!this.accounts.some((a: HubAccount) => a.key === key)) { await this.vault.remove('account:' + key); throw new Error('Account was removed.'); }
        if (privacyEpoch !== this.privacyEpoch) throw new Error('Device locked during authorization. Sign in again.');
        this.access.set(key, { token: tokens.access_token, expires: this.platform.now() + tokens.expires_in * 1000 }); return tokens.access_token;
      } catch (error) {
        this.access.delete(key);
        this.scoped.delete(key);
        if (attempted) await this.vault.remove('account:' + key).catch(() => {});
        if (this.selected === key) { this.selected = ''; this.onDeselected(); this.onChanged(); }
        throw error; // A refresh may have committed. Replaying the old refresh is unsafe.
      }
    })();
    this.rotations.set(key, operation);
    try { return await operation; } finally { this.rotations.delete(key); }
  }
  async token(key: string): Promise<string> {
    const cached = this.scoped.get(key); if (cached && cached.expires > this.platform.now() + 30000) return cached.token;
    const existing = this.scoping.get(key); if (existing) return existing;
    const operation = (async (): Promise<string> => {
      const privacyEpoch = this.privacyEpoch;
      const row = this.account(key), identity = await this.identityToken(key);
      const result = await this.platform.json<{accessToken: string; hubId: string; origin: string; expiresIn: number}>(row.origin, '/api/v1/hub-token', 'POST', JSON.stringify({hubId: row.hubId}), identity);
      if (result.hubId !== row.hubId || result.origin !== row.origin || !this.accounts.some(a => a.key === key)) throw new Error('Hub account changed during authorization.');
      if (privacyEpoch !== this.privacyEpoch) throw new Error('Device locked during authorization.');
      this.scoped.set(key, {token: result.accessToken, expires: this.platform.now() + result.expiresIn * 1000}); return result.accessToken;
    })();
    this.scoping.set(key, operation); try { return await operation; } finally { this.scoping.delete(key); }
  }
  async request<T>(key: string, path: string, method: string = 'GET', body: string = ''): Promise<T> {
    const row = this.account(key), token = await this.token(key);
    return this.platform.json<T>(row.origin, path, method, body, token);
  }
  async computers(key: string): Promise<NativeComputer[]> { return this.request<NativeComputer[]>(key, '/api/v1/computers'); }
  async agents(key: string): Promise<NativeAgent[]> {
    const row = this.account(key), token = await this.identityToken(key);
    return (await this.platform.json<{agents: NativeAgent[]}>(row.origin, '/api/v1/me/agents', 'GET', '', token)).agents;
  }
  async logout(key: string): Promise<void> {
    if (this.selected === key) { this.epoch++; this.selected = ''; this.onDeselected(); }
    await this.serialized(async () => {
      await this.rotations.get(key)?.catch(() => {});
      await this.scoping.get(key)?.catch(() => {});
      const row = this.account(key), value = await this.vault.read('account:' + key);
      await this.beforeLogout(key); // Server registration cleanup while the session still exists.
      this.access.delete(key); this.scoped.delete(key); await this.vault.remove('account:' + key);
      this.accounts = this.accounts.filter((a: HubAccount) => a.key !== key);
      await this.vault.write('hub-accounts', JSON.stringify(this.accounts.map((a: HubAccount) => a.key))); this.onChanged();
      if (value) await this.platform.json(row.origin, '/oauth/revoke', 'POST', JSON.stringify({ token: (JSON.parse(value) as SavedAccount).refreshToken }), '').catch(() => {});
    });
  }
  lock(): void { this.epoch++; this.privacyEpoch++; this.selected = ''; this.access.clear(); this.scoped.clear(); this.onDeselected(); this.onChanged(); }
}
