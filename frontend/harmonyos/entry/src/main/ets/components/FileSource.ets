import { CodeLine, CodeToken, codeLines } from '../model/CodeDocument';
import { nextCharacter } from '../model/EditorMotion';
import { Palette } from '../model/Theme';

class LineSource implements IDataSource {
  private rows: CodeLine[] = [];
  private listeners: DataChangeListener[] = [];
  replace(text: string, path: string): void {
    this.rows = codeLines(text, path);
    this.listeners.forEach((listener: DataChangeListener) => listener.onDataReloaded());
  }
  totalCount(): number { return this.rows.length; }
  getData(index: number): CodeLine { return this.rows[index]; }
  registerDataChangeListener(listener: DataChangeListener): void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
  }
  unregisterDataChangeListener(listener: DataChangeListener): void {
    this.listeners = this.listeners.filter((item: DataChangeListener) => item !== listener);
  }
}

@Component
export struct FileSource {
  @Prop @Watch('refresh') text: string = '';
  @Prop @Watch('refresh') path: string = '';
  @Prop colors: Palette;
  @Prop cursor: number = 0;
  @Prop normal: boolean = false;
  @Prop contentHeight: number = 300;
  interactive: boolean = true;
  scroller: Scroller = new Scroller();
  onScroll: (y: number) => void = () => {};
  private data: LineSource = new LineSource();
  aboutToAppear(): void { this.refresh(); }
  private refresh(): void { this.data.replace(this.text, this.path); }
  private lineCursor(line: CodeLine): number {
    return this.cursor >= line.offset && this.cursor <= line.offset + line.text.length ? this.cursor - line.offset : -1;
  }
  private color(kind: string): string {
    if (kind === 'comment') return this.colors.muted;
    if (kind === 'keyword') return this.colors.accent;
    if (kind === 'string') return this.colors.mode === 'dark' ? '#a8c79b' : '#426b3d';
    if (kind === 'number') return this.colors.mode === 'dark' ? '#aabfe8' : '#355d91';
    return this.colors.text;
  }
  build() {
    List({ scroller: this.scroller }) {
      LazyForEach(this.data, (line: CodeLine) => {
        ListItem() {
          Row({ space: 12 }) {
            Text('' + line.number).width(32).fontSize(12).fontFamily('monospace').fontColor(this.colors.muted).textAlign(TextAlign.End)
            Text() {
              if (this.interactive && this.normal && this.lineCursor(line) >= 0) {
                Span(line.text.slice(0, this.lineCursor(line)))
                Span(line.text.slice(this.lineCursor(line), nextCharacter(line.text, this.lineCursor(line))) || ' ').textBackgroundStyle({ color: this.colors.accent }).fontColor(this.colors.onPrimary)
                Span(line.text.slice(nextCharacter(line.text, this.lineCursor(line))))
              } else { ForEach(line.tokens, (token: CodeToken) => { Span(token.text).fontColor(this.color(token.kind)) }) }
            }.fontColor(this.colors.text).fontSize(13).fontFamily('monospace').lineHeight(20).copyOption(CopyOptions.LocalDevice).layoutWeight(1)
          }.alignItems(VerticalAlign.Top).width('100%').padding({ right: 10 })
        }
      }, (line: CodeLine) => line.number + ':' + line.text)
    }.cachedCount(4).onDidScroll(() => { this.onScroll(this.scroller.currentOffset().yOffset); }).id(this.interactive ? 'file-source' : '')
      .onClick(() => { if (this.interactive) focusControl.requestFocus('file-keyboard'); }).height(this.contentHeight).width('100%').padding({ top: 10, bottom: 10 }).backgroundColor(this.colors.code)
  }
}
