import { HintTarget } from './HintTarget';
import { KeyboardHints } from '../model/KeyboardHints';
import { PdfView, pdfViewManager, pdfService } from '@kit.PDFKit';
import { Palette, palette } from '../model/Theme';

@Component
export struct PdfReader {
  @Consume nativeHints: KeyboardHints;
  @Prop path: string = '';
  @Prop colors: Palette = palette('clay', false);
  @Prop contentHeight: number = 500;
  @State failure: string = '';
  @State passwordRequired: boolean = false;
  @State password: string = '';
  @State loading: boolean = false;
  @State pages: number = 0;
  @State page: number = 0;
  @State zoom: number = 1;
  @State query: string = '';
  @State matches: number = 0;
  @State finding: boolean = false;
  private alive: boolean = true;
  private listening: boolean = false;
  private searchEpoch: number = 0;
  private controller: pdfViewManager.PdfController = new pdfViewManager.PdfController();
  aboutToDisappear(): void {
    this.alive = false; this.searchEpoch++; this.password = '';
    try { this.controller.releaseDocument(); } catch (_) {}
  }
  private async load(): Promise<void> {
    if (this.loading || !this.alive) return;
    this.loading = true; this.failure = ''; this.pages = 0; this.page = 0; this.matches = 0;
    try {
      if (!this.listening) {
        this.listening = true;
        this.controller.registerPageChangedListener((page: number) => { if (this.alive) this.page = page; });
        this.controller.registerScaleChangedListener((zoom: number) => { if (this.alive) this.zoom = zoom; });
        this.controller.registerPageCountChangedListener((count: number) => { if (this.alive) this.pages = count; });
      }
      const attemptedPassword = this.password.length > 0;
      const result = await this.controller.loadDocument(this.path, this.password);
      if (!this.alive) { this.controller.releaseDocument(); return; }
      this.password = '';
      this.passwordRequired = result === pdfService.ParseResult.PARSE_ERROR_PASSWORD;
      if (this.passwordRequired) {
        this.failure = attemptedPassword ? 'Incorrect PDF password. Try again.' : 'This PDF requires a password.';
      } else if (result !== pdfService.ParseResult.PARSE_SUCCESS) {
        this.failure = result === pdfService.ParseResult.PARSE_ERROR_CERT ? 'This PDF requires an unsupported certificate.' : 'Unable to open this PDF. The file may be damaged or unsupported.';
      } else {
        this.pages = this.controller.getPageCount(); this.page = this.controller.getPageIndex(); this.zoom = this.controller.getPageZoom();
      }
    } catch (_) { if (this.alive) this.failure = 'Unable to open this PDF. Try reopening the file.'; }
    finally { if (this.alive) this.loading = false; }
  }
  private search(): void {
    if (!this.pages || this.loading) return;
    const epoch = ++this.searchEpoch;
    this.controller.clearSearch(); this.matches = 0;
    if (!this.query) return;
    this.controller.searchKey(this.query, (count: number) => {
      if (this.alive && epoch === this.searchEpoch) { this.matches = count; if (count > 0) this.controller.setSearchIndex(0); }
    });
  }
  @Builder
  action(label: string, action: () => void, enabled: () => boolean = () => true) {
    HintTarget({ label: label, button: true, available: !this.loading && enabled(), activate: action }) {
    Button(label, { type: ButtonType.Normal }).height(32).constraintSize({ minWidth: 44 }).responseRegion({ x: 0, y: -6, width: '100%', height: 44 }).fontSize(12).padding({ left: 8, right: 8 })
      .fontColor(this.colors.text).backgroundColor(this.colors.subtle).borderRadius(this.colors.radius).enabled(!this.loading && enabled()).onClick(action)
    }
  }
  build() {
    Column({ space: 8 }) {
      if (this.failure) { Text(this.failure).fontColor(this.colors.danger).padding(12) }
      if (this.passwordRequired) {
        Row({ space: 8 }) {
          Row() {
          HintTarget({ label: 'PDF password', activate: () => { focusControl.requestFocus('pdf-password'); } }) {
          TextInput({ text: this.password, placeholder: 'PDF password' }).id('pdf-password').placeholderColor(this.colors.muted).type(InputType.Password).passwordIcon({ onIconSrc: $rawfile('icons/' + this.colors.mode + '/eye.svg'), offIconSrc: $rawfile('icons/' + this.colors.mode + '/eye-off.svg') }).height(44).width('100%')
          .onFocus(() => { this.nativeHints.focus('pdf-password'); }).onBlur(() => { this.nativeHints.blur('pdf-password'); })
            .fontColor(this.colors.text).backgroundColor(this.colors.paper).onChange((value: string) => { this.password = value; }).onSubmit(() => { this.load(); })
          }
          }.layoutWeight(1)
          this.action('Unlock PDF', () => { this.load(); }, () => this.password.length > 0)
        }.width('100%').constraintSize({ minHeight: 44 })
      }
      Row({ space: 6 }) {
        this.action('Previous page', () => { this.controller.goToPage(this.page - 1); }, () => this.pages > 0 && this.page > 0)
        Text('' + (this.pages ? this.page + 1 : 0) + ' / ' + this.pages).fontSize(12).fontColor(this.colors.text).layoutWeight(1).textAlign(TextAlign.Center)
        this.action('Next page', () => { this.controller.goToPage(this.page + 1); }, () => this.page + 1 < this.pages)
      }.width('100%').constraintSize({ minHeight: 44 })
      Row({ space: 6 }) {
        this.action('−', () => { this.controller.setPageZoom(Math.max(0.1, this.zoom / 1.25)); }, () => this.pages > 0)
        Text(Math.round(this.zoom * 100) + '%').fontSize(12).fontColor(this.colors.text).layoutWeight(1).textAlign(TextAlign.Center)
        this.action('+', () => { this.controller.setPageZoom(Math.min(10, this.zoom * 1.25)); }, () => this.pages > 0)
        this.action('Find in PDF', () => { this.finding = !this.finding; if (!this.finding) { this.searchEpoch++; this.controller.clearSearch(); } }, () => this.pages > 0)
      }.width('100%').constraintSize({ minHeight: 44 })
      if (this.finding) {
        Row({ space: 6 }) {
          Row() {
          HintTarget({ label: 'Search PDF', activate: () => { focusControl.requestFocus('pdf-query'); } }) {
          TextInput({ text: this.query, placeholder: 'Search PDF' }).id('pdf-query').height(44).fontColor(this.colors.text).placeholderColor(this.colors.muted).backgroundColor(this.colors.subtle).width('100%').fontSize(13).onChange((value: string) => { this.query = value; }).onSubmit(() => { this.search(); })
          .onFocus(() => { this.nativeHints.focus('pdf-query'); }).onBlur(() => { this.nativeHints.blur('pdf-query'); })
          }
          }.layoutWeight(1)
          this.action('Find', () => { this.search(); })
          this.action('Next', () => { this.controller.setSearchIndex((this.controller.getSearchIndex() + 1) % this.matches); }, () => this.matches > 0)
          Text('' + this.matches).fontSize(12).fontColor(this.colors.muted)
        }
      }
      PdfView({ controller: this.controller }).width('100%').layoutWeight(1).onAppear(() => { this.load(); })
    }.width('100%').height(this.contentHeight)
  }
}
