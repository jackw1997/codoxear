import { HintTarget } from './HintTarget';
import { Palette, palette, themeVariables } from '../model/Theme';
import { codeLines, CodeLine, CodeToken } from '../model/CodeDocument';

@Component
export struct MarkdownCode {
  @Prop text: string = '';
  @Prop language: string = '';
  @Prop query: string = '';
  @Prop lineHeight: number = 1.55;
  @Prop colors: Palette = palette('clay', false);
  @Prop hintScope: string = 'chat';
  onCopy: (text: string) => void = () => {};
  @State revealed: boolean = false;
  @State hovered: boolean = false;
  @State copied: boolean = false;
  private timer: number = -1;
  aboutToDisappear(): void { if (this.timer !== -1) clearTimeout(this.timer); }
  private copy(): void {
    this.onCopy(this.text); this.copied = true;
    if (this.timer !== -1) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.copied = false; this.timer = -1; }, 1200);
  }
  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Scroll() {
        Text() {
          ForEach(codeLines(this.text, this.language, this.query), (line: CodeLine, index: number) => {
            if (index > 0) { Span('\n') }
            ForEach(line.tokens, (token: CodeToken) => {
              Span(token.text).textBackgroundStyle({ color: token.highlight ? themeVariables(this.colors.family, this.colors.mode === 'dark')['surface-highlight'] : Color.Transparent })
            })
          })
        }.fontFamily('monospace').fontSize(13).lineHeight(13 * this.lineHeight).fontColor(this.colors.text)
          .copyOption(CopyOptions.LocalDevice).textAlign(TextAlign.Start).id('markdown-code')
          .onClick(() => { this.revealed = !this.revealed; })
      }.scrollable(ScrollDirection.Horizontal).align(Alignment.Start).width('100%').padding(12)
      if (this.revealed || this.hovered || this.copied) {
        Row() {
        HintTarget({ label: 'Copy code', scope: this.hintScope, activate: () => { this.copy(); } }) {
          Button(this.copied ? '✓' : '⧉', { type: ButtonType.Normal }).width(32).height(32).fontSize(16)
            .backgroundColor(this.copied ? this.colors.ink : this.colors.paper)
            .fontColor(this.copied ? this.colors.paper : this.colors.ink)
            .border({ width: 1, color: this.colors.ink }).borderRadius(this.colors.radius)
            .accessibilityText('Copy code').id('Copy code').onClick(() => { this.copy(); })
        }
        }.margin({ top: 6, right: 6 })
      }
    }.width('100%').backgroundColor(this.colors.family === 'paper' ? this.colors.subtle : this.colors.code).borderRadius(this.colors.cardRadius)
      .border({ width: 1, color: this.colors.hairline }).onHover((value: boolean) => { this.hovered = value; })
  }
}
