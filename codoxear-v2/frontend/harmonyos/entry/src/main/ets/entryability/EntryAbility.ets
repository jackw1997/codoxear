import { UIAbility, Want, AbilityConstant } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { IdentityPlatform, AssetVault, PushKitInstallation } from '../services/IdentityPlatform';
import { NativeApp } from '../model/NativeApp';
import { Startup } from '../model/Startup';
export default class EntryAbility extends UIAbility {
  private app: NativeApp | undefined = undefined;
  private ready: Promise<void> = Promise.resolve();
  private startup: Startup = new Startup();
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    AppStorage.setOrCreate('codoxearNativeStartup', this.startup);
    this.ready = this.initialize(); void this.receive(want).catch(() => {});
  }
  private async initialize(): Promise<void> {
    const platform = new IdentityPlatform(this.context), vault = new AssetVault(platform);
    let installation = await vault.read('installation-id');
    if (!installation) { installation = platform.random(); await vault.write('installation-id', installation); }
    this.app = new NativeApp(vault, platform, new PushKitInstallation(this), installation);
    AppStorage.setOrCreate('codoxearNativeApp', this.app);
    await this.app.initialize(this.context.filesDir);
  }
  onWindowStageCreate(stage: window.WindowStage): void {
    this.startup.retry = async () => { this.ready = this.initialize(); await this.ready; await stage.loadContent('pages/Index'); };
    void this.ready.then(() => stage.loadContent('pages/Index')).catch(error => {
      this.startup.error = error.message; void stage.loadContent('pages/Unlock');
    });
  }
  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void { void this.receive(want).catch(error => { this.startup.error = error.message; }); }
  private async receive(want: Want): Promise<void> {
    await this.ready; const app = this.app; if (!app) return;
    if (want.uri) await app.callback(want.uri);
    const p = want.parameters;
    if (p && typeof p['codoxear.session'] === 'string' && typeof p['codoxear.server'] === 'string' && typeof p['codoxear.computer'] === 'string' && typeof p['codoxear.hub'] === 'string') {
      await app.openNotification({ localId: p['codoxear.session'] as string, server: p['codoxear.server'] as string, computerId: p['codoxear.computer'] as string, hubId: p['codoxear.hub'] as string });
    }
  }
  onBackground(): void { this.app?.background(); }
  onForeground(): void { void this.ready.then(() => this.app?.foreground()).catch(error => { this.startup.error = error.message; if (this.app) { this.app.error = error.message; this.app.onChanged(); } }); }
  onDestroy(): void { this.app?.dispose(); }
}
