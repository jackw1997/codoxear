import { nativePush } from '../services/NativePush';
import { clearMathCache } from '../services/MathAsset';
import { UIAbility, Configuration, Want, AbilityConstant } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

export default class EntryAbility extends UIAbility {
  private receiveNotification(want: Want): void {
    const session = want.parameters?.['codoxear.session'];
    const server = want.parameters?.['codoxear.server'];
    if (typeof session === 'string' && typeof server === 'string' && session && server.endsWith('/api/me')) {
      AppStorage.setOrCreate('notification-route', JSON.stringify({ session: session, server: server, time: Date.now() }));
    }
  }
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void { nativePush.bind(this); this.receiveNotification(want); }
  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void { this.receiveNotification(want); }
  onDestroy(): void { nativePush.detach(); }
  onConfigurationUpdate(configuration: Configuration): void { AppStorage.setOrCreate('system-color-mode', configuration.colorMode ?? -1); }
  onWindowStageCreate(stage: window.WindowStage): void {
    clearMathCache(this.context.cacheDir);
    stage.getMainWindow().then((main: window.Window) => main.setPreferredOrientation(window.Orientation.AUTO_ROTATION)).catch(() => {});
    stage.loadContent('pages/Index');
  }
}
