import hdc from 'libhdc_z.so';
import { common, bundleManager } from '@kit.AbilityKit';
import { picker, fileIo as fs } from '@kit.CoreFileKit';
import { request } from '@kit.BasicServicesKit';

@Entry @Component
struct Index {
  @State output: string = '选择更新包，或粘贴更新链接。';
  @State busy: boolean = false;
  @State url: string = '';
  @State ready: boolean = false;
  @State installed: string = '';
  aboutToAppear(): void {
    bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT).then((info: bundleManager.BundleInfo) => {
      this.installed = '当前版本 ' + info.versionName + ' · 最近安装 ' + new Date(info.updateTime).toLocaleString();
    }).catch(() => {});
  }
  private started: boolean = false;
  private ctx(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  private command(args: string): Promise<string> {
    const dir = this.ctx().filesDir;
    const delay = this.started ? 20 : 1000;
    if (!this.started) { hdc.hdcStartServer(dir); this.started = true; }
    return new Promise<string>((resolve) => {
      setTimeout(() => { hdc.hdcRun('hdc ' + args, dir, (result: string): void => { resolve(result); }); }, delay);
    });
  }
  private packagePath(): string { return this.ctx().cacheDir + '/codoxear-update.hap'; }
  private async choose(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.ready = false;
    try {
      const files = await new picker.DocumentViewPicker(this.ctx()).select({ maxSelectNumber: 1 });
      if (files.length === 0) return;
      const source = await fs.open(files[0], fs.OpenMode.READ_ONLY);
      try { await fs.copyFile(source.fd, this.packagePath()); } finally { await fs.close(source); }
      this.ready = true; this.output = '更新包已准备好。点击安装将覆盖更新并保留应用数据。';
    } catch (e) { this.output = '读取失败：' + String(e); }
    finally { this.busy = false; }
  }
  private async download(): Promise<void> {
    if (this.busy) return;
    const address = this.url.trim();
    if (!address.startsWith('https://')) { this.output = '请粘贴 HTTPS 更新链接。'; return; }
    this.busy = true; this.ready = false; this.output = '正在下载更新包…';
    try {
      try { await fs.unlink(this.packagePath()); } catch (_) {}
      const task = await request.downloadFile(this.ctx(), { url: address, filePath: this.packagePath(), enableMetered: true, enableRoaming: true });
      await new Promise<void>((resolve, reject) => {
        task.on('complete', () => resolve());
        task.on('fail', (code: number) => reject(new Error('下载失败（' + code + '）')));
        task.query().then((info: request.DownloadInfo) => {
          if (info.status === request.SESSION_SUCCESSFUL) resolve();
          if (info.status === request.SESSION_FAILED) reject(new Error('下载失败（' + info.failedReason + '）'));
        }).catch((error: Error) => reject(error));
      });
      const stat = await fs.stat(this.packagePath());
      if (stat.size < 1024) throw new Error('文件过小，请检查下载链接');
      this.ready = true; this.output = '下载完成（' + Math.round(stat.size / 1024) + ' KB）。可以安装。';
    } catch (e) { this.output = String(e); }
    finally { this.busy = false; }
  }
  private async install(): Promise<void> {
    if (this.busy || !this.ready) return;
    this.busy = true; this.output = '正在连接本机…';
    try {
      const connected = await this.command('tconn 127.0.0.1:38765');
      if (!connected.includes('Connect OK') && !connected.includes('already')) {
        const targets = await this.command('list targets');
        if (!targets.includes('127.0.0.1:38765')) throw new Error('本机连接失败：' + connected);
      }
      this.output = '正在覆盖安装；应用可能自动关闭，完成后请重新打开 Codoxear。';
      const result = await this.command('-t 127.0.0.1:38765 install -r ' + this.packagePath());
      this.output = result;
    } catch (e) { this.output = String(e); }
    finally { this.busy = false; }
  }
  private async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { this.output = await this.command('tconn 127.0.0.1:38765'); }
    finally { this.busy = false; }
  }
  build() {
    Scroll() {
      Column({ space: 20 }) {
        Text('Codoxear 更新').fontSize(26).fontWeight(FontWeight.Bold)
        Text('下载签名更新包后，选择文件并安装。可使用手机流量。').fontSize(16)
        Text(this.installed).fontSize(13)
        TextInput({ placeholder: '粘贴 HTTPS 更新链接', text: this.url }).onChange((value: string) => this.url = value)
        Button('下载更新包').enabled(!this.busy).onClick(() => this.download())
        Button('选择已下载的更新包').enabled(!this.busy).onClick(() => this.choose())
        Button('安装更新（保留数据）').enabled(!this.busy && this.ready).onClick(() => {
          AlertDialog.show({ title: '安装 Codoxear 更新？', message: '将覆盖当前版本并保留数据。安装时应用可能关闭。',
            primaryButton: { value: '取消', action: () => {} },
            secondaryButton: { value: '安装', action: () => { this.install(); } } });
        })
        Button('检查本机连接').enabled(!this.busy).onClick(() => this.check())
        Text(this.output).fontSize(15).width('100%')
        Button('打开 Codoxear').enabled(!this.busy).onClick(() => {
          this.ctx().startAbility({ bundleName: 'com.codoxear.mobile', moduleName: 'entry', abilityName: 'EntryAbility' }).catch((error: Error) => { this.output = String(error); });
        })
        Text('请保持开发者模式和 USB 调试开启。安装过程中保持本页在前台。').fontSize(13)
      }.padding(24).padding({ top: 70 }).width('100%')
    }.width('100%').height('100%')
  }
}
