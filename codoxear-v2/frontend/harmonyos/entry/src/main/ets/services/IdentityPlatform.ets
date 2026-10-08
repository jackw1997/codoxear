import { asset } from '@kit.AssetStoreKit';
import { util, url } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { common, UIAbility } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { pushService } from '@kit.PushKit';
import { SecureVault, NativeIdentityPlatform, Callback } from './HubAccounts';
import { InstallationPush } from './HubPush';

const encoder = new util.TextEncoder();
function base64url(value: Uint8Array): string { return new util.Base64Helper().encodeToStringSync(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
export class IdentityPlatform implements NativeIdentityPlatform {
  constructor(private context: common.UIAbilityContext) {}
  now(): number { return Date.now(); }
  random(): string { return base64url(cryptoFramework.createRandom().generateRandomSync(32).data); }
  async sha256(value: string): Promise<string> {
    const digest = cryptoFramework.createMd('SHA256'); await digest.update({ data: encoder.encodeInto(value) });
    return base64url((await digest.digest()).data);
  }
  callback(value: string): Callback {
    const parsed = new url.URL(value);
    if (parsed.hash || parsed.username || parsed.password) throw new Error('Invalid sign-in callback.');
    for (const name of ['state', 'code', 'iss', 'error']) if (parsed.searchParams.getAll(name).length > 1) throw new Error('Duplicate callback parameter.');
    return { base: parsed.protocol + '//' + parsed.host + parsed.pathname, state: parsed.searchParams.get('state') || '',
      code: parsed.searchParams.get('code') || '', issuer: parsed.searchParams.get('iss') || '', error: parsed.searchParams.get('error') || '' };
  }
  openBrowser(value: string): Promise<void> { return this.context.openLink(value, { appLinkingOnly: false }); }
  async json<T>(origin: string, path: string, method: string, body: string, token: string): Promise<T> {
    if (!/^https:\/\/[^\s/?#@]+$/.test(origin) || !/^\/(?:oauth|api)\//.test(path) || /[\\\r\n\0]/.test(path)) throw new Error('Invalid Hub request.');
    const connection = http.createHttp();
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      if (body) headers['Content-Type'] = 'application/json';
      const response = await connection.request(origin + path, { method: method as http.RequestMethod, header: headers,
        extraData: body || undefined, expectDataType: http.HttpDataType.STRING, usingCache: false, connectTimeout: 15000, readTimeout: 30000 });
      if (response.responseCode >= 300 && response.responseCode < 400) throw new Error('Hub redirects are not accepted.');
      const value = JSON.parse(response.result as string) as T;
      if (response.responseCode < 200 || response.responseCode >= 300) throw new Error('Hub request rejected (' + response.responseCode + ').');
      return value;
    } finally { connection.destroy(); }
  }
}
export class AssetVault implements SecureVault {
  private writes: Promise<void> = Promise.resolve();
  constructor(private platform: NativeIdentityPlatform) {}
  private async query(key: string): Promise<asset.AssetMap> {
    const query: asset.AssetMap = new Map(); query.set(asset.Tag.ALIAS, encoder.encodeInto('codoxear.native.v2.' + await this.platform.sha256(key))); return query;
  }
  async read(key: string): Promise<string | null> {
    await this.writes;
    const query = await this.query(key); query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try { const rows = await asset.query(query); return rows.length ? util.TextDecoder.create('utf-8').decodeWithStream(rows[0].get(asset.Tag.SECRET) as Uint8Array) : null; }
    catch (error) { if ((error as Error & { code: number }).code === asset.ErrorCode.NOT_FOUND) return null; throw new Error('Unlock this device to access Hub credentials.'); }
  }
  private serialized(operation: () => Promise<void>): Promise<void> { const next = this.writes.catch(() => {}).then(operation); this.writes = next.catch(() => {}); return next; }
  write(key: string, value: string): Promise<void> {
    return this.serialized(async () => {
      const bytes = encoder.encodeInto(value); if (bytes.length > 1024) throw new Error('Credential exceeds the secure asset limit.');
      const attributes = await this.query(key); attributes.set(asset.Tag.SECRET, bytes);
      attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED); attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
      await asset.add(attributes);
    });
  }
  remove(key: string): Promise<void> {
    return this.serialized(async () => { try { await asset.remove(await this.query(key)); }
      catch (error) { if ((error as Error & { code: number }).code !== asset.ErrorCode.NOT_FOUND) throw error; } });
  }
}
export class PushKitInstallation implements InstallationPush {
  constructor(private ability: UIAbility) {}
  getToken(): Promise<string> { return pushService.getToken(); }
  deleteToken(): Promise<void> { return pushService.deleteToken(); }
  watch(updated: (token: string) => void): () => void {
    pushService.on('tokenUpdate', this.ability, updated);
    return () => { pushService.off('tokenUpdate', updated); };
  }
}
