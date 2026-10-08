import { pushService } from '@kit.PushKit';
import { UIAbility } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';
import { ApiClient, ApiError } from './ApiClient';

interface Registration { device_id: string; token: string; server: string; enabled: boolean; }
interface PushStatus { configured: boolean; reason?: string; test_message?: boolean; }
interface RegistrationResult { registered: boolean; }

// Serialized token ownership. Persist before POST so a lost response remains revocable.
export class NativePush {
  private directory: string = '';
  private ability: UIAbility | undefined = undefined;
  private registration: Registration | undefined = undefined;
  private work: Promise<void> = Promise.resolve();
  private watching: boolean = false;
  private lifecycle: number = 0;
  private api: ApiClient | undefined = undefined;
  private report: (message: string) => void = () => {};
  private tokenUpdated = (token: string): void => {
    this.serialize(async () => {
      const current = this.registration;
      const api = this.api;
      if (!current?.enabled || !api || current.server !== api.notificationScope() || !token) return;
      current.token = token; this.persist();
      await this.upload(api, current);
    }).catch(() => { this.report('Background notification registration needs retry. Re-enable notifications.'); });
  };
  bind(ability: UIAbility): void { this.ability = ability; }
  initialize(directory: string): void {
    if (this.directory === directory) return;
    this.directory = directory;
    try {
      const value = JSON.parse(fs.readTextSync(directory + '/native-push.json')) as Registration;
      if (typeof value.device_id === 'string' && typeof value.token === 'string' && typeof value.server === 'string' && typeof value.enabled === 'boolean') this.registration = value;
    } catch (_) {}
  }
  private persist(): void {
    if (!this.directory) throw new Error('Notification storage is not ready.');
    const path = this.directory + '/native-push.json';
    const file = fs.openSync(path + '.tmp', fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    const bytes = new util.TextEncoder().encodeInto(JSON.stringify(this.registration || null));
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = fs.writeSync(file.fd, bytes.buffer.slice(offset));
        if (count <= 0) throw new Error('Notification registration write was incomplete.');
        offset += count;
      }
    } finally { fs.closeSync(file); }
    fs.renameSync(path + '.tmp', path);
  }
  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.work.catch(() => {}).then(action); this.work = next; return next;
  }
  private async upload(api: ApiClient, registration: Registration): Promise<void> {
    const response = JSON.parse(await api.request('/api/notifications/harmony', http.RequestMethod.POST, JSON.stringify(registration))) as RegistrationResult;
    if (response.registered !== registration.enabled) throw new Error('Background notification registration was not confirmed.');
  }
  private watch(api: ApiClient, report: (message: string) => void): void {
    this.api = api; this.report = report;
    if (!this.watching && this.ability) {
      try { pushService.on('tokenUpdate', this.ability, this.tokenUpdated); this.watching = true; }
      catch (_) { /* Earlier systems refresh the token at the next login. */ }
    }
  }
  detach(): void {
    if (this.watching) { try { pushService.off('tokenUpdate', this.tokenUpdated); } catch (_) {} }
    this.lifecycle++; this.watching = false; this.api = undefined;
  }
  private rememberForeground(server: string): void {
    this.registration = { device_id: this.registration?.device_id || util.generateRandomUUID(), token: '', server: server, enabled: true };
    this.persist();
  }
  requested(server: string): boolean { return !!this.registration?.enabled && this.registration.server === server; }
  hasRegistration(): boolean { return !!this.registration?.token; }
  async enable(api: ApiClient, report: (message: string) => void): Promise<boolean> {
    let background = false;
    const lifecycle = this.lifecycle;
    await this.serialize(async () => {
      const server = api.notificationScope();
      if (this.registration && this.registration.server !== server) await this.revokeToken();
      let status: PushStatus;
      try { status = JSON.parse(await api.request('/api/notifications/harmony')) as PushStatus; }
      catch (reason) {
        if ((reason as ApiError).status !== 404) throw new Error((reason as Error).message);
        status = { configured: false, reason: 'This server does not support background notifications yet.' };
      }
      if (!status.configured) {
        if (this.registration?.token) throw new Error(status.reason || 'Background notifications are unavailable.');
        this.rememberForeground(server);
        report('App running only. ' + (status.reason || 'Background push is not configured.')); return;
      }
      let token: string;
      try { token = await pushService.getToken(); }
      catch (_) {
        if (this.registration?.token) throw new Error('Unable to refresh the background notification token.');
        this.rememberForeground(server);
        report('App running only. Background push requires a signed app with PushKit enabled.'); return;
      }
      this.registration = { device_id: this.registration?.device_id || util.generateRandomUUID(), token: token, server: server, enabled: true };
      this.persist();
      await this.upload(api, this.registration);
      if (lifecycle === this.lifecycle) this.watch(api, report);
      background = true;
      report(status.test_message ? 'Background notifications registered (test mode; delivery not verified).' : 'Background notifications registered.');
    });
    return background;
  }
  private async revokeToken(): Promise<void> {
    if (!this.registration) return;
    const token = this.registration.token;
    // Also works after cookie expiry or when the previous server is unavailable.
    this.registration.enabled = false; this.persist(); this.detach();
    if (token) await pushService.deleteToken();
    this.registration = undefined; this.persist();
  }
  revokeLocal(): Promise<void> { return this.serialize(() => this.revokeToken()); }
  disable(api: ApiClient): Promise<void> {
    return this.serialize(async () => {
      const current = this.registration;
      if (!current) return;
      let removed = false;
      if (current.token && current.server === api.notificationScope()) {
        try { await this.upload(api, { device_id: current.device_id, token: current.token, server: current.server, enabled: false }); removed = true; }
        catch (_) { /* Token deletion below revokes delivery even while the server is offline. */ }
      }
      try { await this.revokeToken(); }
      catch (_) {
        if (!removed) throw new Error('Unable to disable background notifications. Reconnect and try again.');
        // Server removal is sufficient; retain the token so later logout can retry deletion.
        current.enabled = false; this.persist(); this.detach();
      }
    });
  }
}
export const nativePush: NativePush = new NativePush();
