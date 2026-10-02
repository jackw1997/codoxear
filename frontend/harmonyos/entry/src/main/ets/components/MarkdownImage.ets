import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { ApiClient } from '../services/ApiClient';
import { FileContent } from '../model/Contracts';

@Component
export struct MarkdownImage {
  @Prop @Watch('load') source: string = '';
  @Prop muted: string = '#8a7f6f';
  @Prop label: string = '';
  @Prop @Watch('load') sessionId: string = '';
  api: ApiClient = new ApiClient();
  onOpen: (path: string) => void = () => {};
  @State local: string = '';
  @State ratio: number = 16 / 9;
  @State error: string = '';
  private generation: number = 0;
  private cachedFile: string = '';

  aboutToAppear(): void { this.load(); }
  aboutToDisappear(): void { this.generation++; this.removeCache(); }
  private removeCache(): void {
    if (this.cachedFile) { try { fs.unlinkSync(this.cachedFile); } catch (_) {} }
    this.cachedFile = '';
  }
  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.removeCache(); this.local = ''; this.error = ''; this.ratio = 16 / 9;
    if (/^https?:\/\//i.test(this.source)) { this.local = this.source; return; }
    if (!this.sessionId || !this.source || /^[a-z][a-z\d+.-]*:/i.test(this.source)) { this.error = 'Image unavailable'; return; }
    try {
      const path = '/api/sessions/' + encodeURIComponent(this.sessionId) + '/file/read?path=' + encodeURIComponent(this.source);
      const content = JSON.parse(await this.api.request(path)) as FileContent;
      if (generation !== this.generation) return;
      if (!content.image_url) throw new Error('Image preview unavailable');
      const bytes = await this.api.binary(content.image_url);
      if (generation !== this.generation) return;
      const context = getContext(this) as common.UIAbilityContext;
      this.cachedFile = context.cacheDir + '/markdown-' + Date.now() + '-' + Math.floor(Math.random() * 1000000000) + '.image';
      const file = fs.openSync(this.cachedFile, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      try { fs.writeSync(file.fd, bytes); } finally { fs.closeSync(file); }
      this.local = 'file://' + this.cachedFile;
    } catch (_) { if (generation === this.generation) this.error = 'Image unavailable'; }
  }
  build() {
    Column({ space: 4 }) {
      if (this.local) {
        Image(this.local).width('100%').aspectRatio(this.ratio).objectFit(ImageFit.Contain)
          .accessibilityText(this.label).onComplete((event) => {
            if (event && event.width > 0 && event.height > 0) this.ratio = event.width / event.height;
          }).onError(() => { this.error = 'Image unavailable'; }).onClick(() => { this.onOpen(this.source); })
      }
      if (this.error || !this.local) { Text(this.error || 'Loading image…').fontSize(12).fontColor(this.muted) }
      if (this.label) { Text(this.label).fontSize(12).fontColor(this.muted).onClick(() => { this.onOpen(this.source); }) }
    }.width('100%')
  }
}
