import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';

interface LoginSecret { server: string; password: string; }

// One last-used login, kept in the OS encrypted, app-private asset store.
// Neither the password nor the endpoint is placed in unencrypted asset labels.
export class SavedLogin {
  private writes: Promise<void> = Promise.resolve();
  private write(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }
  private query(): asset.AssetMap {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto('codoxear.saved-login.v1'));
    return query;
  }
  private normalize(server: string): string { return server.trim().replace(/\/+$/, ''); }

  async password(server: string): Promise<string> {
    await this.writes;
    const query = this.query();
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const rows = await asset.query(query);
      if (!rows.length) return '';
      const secret = rows[0].get(asset.Tag.SECRET) as Uint8Array;
      const saved = JSON.parse(util.TextDecoder.create('utf-8').decodeWithStream(secret)) as LoginSecret;
      return saved.server === this.normalize(server) && typeof saved.password === 'string' ? saved.password : '';
    } catch (reason) {
      if ((reason as BusinessError).code === asset.ErrorCode.NOT_FOUND) return '';
      throw new Error('Unable to read the saved password. Unlock your device and try again.');
    }
  }

  async save(server: string, password: string): Promise<void> {
    const value: LoginSecret = { server: this.normalize(server), password: password };
    const secret = new util.TextEncoder().encodeInto(JSON.stringify(value));
    if (secret.length > 1024) throw new Error('This login is too long to save securely.');
    const attributes = this.query();
    attributes.set(asset.Tag.SECRET, secret);
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
    attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
    try { await this.write(() => asset.add(attributes)); }
    catch (_) { throw new Error('Signed in, but the password could not be saved securely.'); }
  }

  async clear(): Promise<void> {
    try { await this.write(() => asset.remove(this.query())); }
    catch (reason) {
      if ((reason as BusinessError).code !== asset.ErrorCode.NOT_FOUND) {
        throw new Error('Unable to remove the saved password. Unlock your device and try again.');
      }
    }
  }
}
