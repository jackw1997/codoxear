import { HintTarget } from './HintTarget';
import { NativeInline } from './NativeInline';
import { HintBounds } from '../model/KeyboardHints';
import { fileLink, fileLocation, fileReferenceLink } from '../model/FileLinks';
import { MarkdownCode } from './MarkdownCode';
import { Palette, palette, themeVariables } from '../model/Theme';
import { MarkdownBlock, InlinePart, markdownBlocks, highlightedParts, fileReferenceParts, measureInlineWidth } from '../model/Markdown';
import { ApiClient } from '../services/ApiClient';
import { MarkdownImage } from './MarkdownImage';
import { inspectReferences, ResolvedReference } from '../services/FileReferences';
import { common } from '@kit.AbilityKit';
import { MathAsset, mathAsset } from '../services/MathAsset';

@Component
export struct MarkdownView {
  @Prop hintScope: string = 'chat';
  @Prop hintClip: HintBounds = { x: 0, y: 0, width: 0, height: 0 };
  @Prop @Watch('loadReferences') text: string = '';
  @Prop @Watch('loadReferences') basePath: string = '';
  @Prop searchQuery: string = '';
  @Prop fontSize: number = 16;
  @Prop lineHeight: number = 1.35;
  @Prop colors: Palette = palette('clay', false);
  @Prop @Watch('loadReferences') sessionId: string = '';
  api: ApiClient = new ApiClient();
  onLink: (url: string) => void = () => {};
  onCopy: (text: string) => void = () => {};
  onTap: () => void = () => {};
  onHeading: (anchor: string, y: number) => void = () => {};
  @State references: ResolvedReference[] = [];
  private referenceGeneration: number = 0;
  aboutToAppear(): void { this.loadReferences(); }
  aboutToDisappear(): void { this.referenceGeneration++; }
  private async loadReferences(): Promise<void> {
    const generation = ++this.referenceGeneration;
    this.references = [];
    if (!this.sessionId) return;
    const paths: string[] = [];
    markdownBlocks(this.text).forEach((block: MarkdownBlock) => {
      const parts: InlinePart[] = block.parts.concat(block.table.flatMap((row: InlinePart[][]) => row.flatMap((cell: InlinePart[]) => cell)));
      fileReferenceParts(parts).forEach((part: InlinePart) => {
        const target = part.candidate || part.url;
        if (target && !target.startsWith('#') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target.replace(/:\d+(?::\d+)?$/, ''))) paths.push(fileLocation(fileLink(this.basePath, target)).path);
      });
    });
    if (!paths.length) return;
    try {
      const resolved = await inspectReferences(this.api, this.sessionId, paths);
      if (generation === this.referenceGeneration) this.references = resolved;
    } catch (_) { /* A disconnected or missing candidate remains plain text. */ }
  }
  private linkTarget(part: InlinePart): string {
    if (!part.url && !part.candidate) return '';
    const location = fileLocation(fileLink(this.basePath, part.candidate || part.url));
    const found = this.references.find((reference: ResolvedReference) => reference.path === location.path);
    return found ? (found.directory ? 'codoxear-directory:' + encodeURIComponent(found.target) : found.choice ? 'codoxear-choice:' + encodeURIComponent(found.target + location.location) : fileReferenceLink(found.target, location.location, found.apiPath)) : part.url ? fileLink(this.basePath, part.url) : '';
  }
  private formula(latex: string, display: boolean = false): MathAsset {
    const matched = !!this.searchQuery && latex.toLowerCase().includes(this.searchQuery.toLowerCase());
    return mathAsset(latex, this.colors.text, display, (getContext(this) as common.UIAbilityContext).cacheDir,
      matched ? this.token('surface-highlight') : '');
  }
  private token(name: string): string {
    const variables = themeVariables(this.colors.family, this.colors.mode === 'dark');
    let value = variables[name] || this.colors.hairline;
    for (let i = 0; i < 8 && value.startsWith('var(--'); i++) value = variables[value.slice(6, -1)] || this.colors.hairline;
    return value;
  }
  private columnWidth(item: MarkdownBlock, column: number): number {
    let width = 0;
    item.table.forEach((row: InlinePart[][], index: number) => {
      const measured = measureInlineWidth(row[column] || [], (text: string, part: InlinePart): number =>
        this.getUIContext().px2vp(this.getUIContext().getMeasureUtils().measureText({ textContent: text, fontSize: 13,
          fontWeight: index === 0 || part.bold ? 'bold' : 'normal', fontFamily: part.code ? 'monospace' : 'HarmonyOS Sans' })));
      if (Number.isFinite(measured)) width = Math.max(width, measured);
    });
    return Math.ceil(width) + 20;
  }
  private gap(item: MarkdownBlock, index: number): number {
    const blocks = markdownBlocks(this.text);
    if (index === blocks.length - 1) return item.quote || ['code', 'table', 'image'].includes(item.kind) ? 12 : 0;
    const next = blocks[index + 1];
    if (item.prefix && next.prefix && item.indent === next.indent) return 4;
    return item.quote || ['code', 'table', 'image'].includes(item.kind) ? 12 : 10;
  }
  private renderedParts(parts: InlinePart[]): InlinePart[] {
    const output: InlinePart[] = [];
    const rendered = highlightedParts(fileReferenceParts(parts), this.searchQuery);
    rendered.forEach((part: InlinePart, index: number) => {
      const url = this.linkTarget(part);
      output.push({ text: part.text, bold: part.bold, italic: part.italic, code: part.code, strike: part.strike,
        url: url, image: part.image, math: part.math, display: part.display, highlight: part.highlight });
      if (url.startsWith('codoxear-choice:') && (index === rendered.length - 1 || this.linkTarget(rendered[index + 1]) !== url)) output.push({ text: ' choose ', bold: false, italic: false, code: false,
        strike: false, url: url, image: false, math: '', display: false, choice: true });
    });
    return output;
  }
  @Builder
  inline(parts: InlinePart[], size: number = 16, bold: boolean = false, align: string = 'left', leading: number = this.lineHeight) {
    NativeInline({ parts: this.renderedParts(parts), colors: this.colors, textSize: size, bold: bold,
      lineHeight: leading, alignment: align, hintScope: this.hintScope, hintClip: this.hintClip,
      onLink: this.onLink, onTap: this.onTap })
  }
  @Builder
  content(item: MarkdownBlock) {
    if (item.kind === 'code') {
      MarkdownCode({ text: item.text, language: item.language, query: this.searchQuery, lineHeight: this.lineHeight,
        colors: this.colors, hintScope: this.hintScope, onCopy: this.onCopy })
    } else if (item.kind === 'heading') { this.inline(item.parts, item.level === 1 ? 18 : item.level === 2 ? 16 : 14, true, 'left', 1.15) }
    else if (item.kind === 'rule') { Divider().color(this.colors.hairline).margin({ top: 6, bottom: 6 }) }
    else if (item.kind === 'math') {
      if (this.formula(item.text, true).source) {
        Scroll() { Image(this.formula(item.text, true).source).width(this.formula(item.text, true).width).height(this.formula(item.text, true).height).objectFit(ImageFit.Contain).accessibilityText(item.text) }
          .scrollable(ScrollDirection.Horizontal).width('100%').padding({ top: 6, bottom: 6 })
      } else { Text(item.text).fontFamily('monospace').fontColor(this.colors.text).copyOption(CopyOptions.LocalDevice) }
    }
    else if (item.kind === 'image') {
      HintTarget({ label: item.text || 'Open image', scope: this.hintScope, activate: () => { this.onLink(fileLink(this.basePath, item.url)); } }) {
        MarkdownImage({ source: fileLink(this.basePath, item.url), label: item.text, sessionId: this.sessionId, api: this.api, muted: this.colors.muted, onOpen: this.onLink })
      }
    }
    else if (item.kind === 'table') {
      Scroll() {
        Column() {
          ForEach(item.table, (row: InlinePart[][], index: number) => {
            Row() {
              ForEach(row, (cell: InlinePart[], column: number) => {
                Column() { this.inline(cell, 13, index === 0, item.align[column], 1.35) }.width(this.columnWidth(item, column)).padding({ left: 10, right: 10, top: 8, bottom: 8 }).border({ width: { bottom: index === item.table.length - 1 ? 0 : 1 }, color: index === 0 ? this.colors.border : this.colors.hairline })
              })
            }.backgroundColor(index === 0 ? this.colors.wash : this.colors.paper)
          })
        }.border({ width: 1, color: this.colors.border }).borderRadius(this.colors.cardRadius).clip(true)
      }.scrollable(ScrollDirection.Horizontal).align(Alignment.Start).width('100%')
    } else { this.inline(item.parts, this.fontSize) }
  }
  build() {
    Column() {
      ForEach(markdownBlocks(this.text), (item: MarkdownBlock, index: number) => {
        Row({ space: 8 }) {
          if (item.checked >= 0) {
            Stack() {
              if (item.checked === 1) {
                Polyline().points([[3, 8], [6.5, 11.5], [13, 4.5]]).stroke(this.colors.onPrimary).strokeWidth(1.5).fill(Color.Transparent).width(16).height(16)
              }
            }.width(16).height(16).margin({ top: 4, right: 6 }).borderRadius(this.colors.radius).border({ width: 1, color: this.colors.border })
              .backgroundColor(item.checked === 1 ? this.colors.primary : Color.Transparent)
              .accessibilityText(item.checked === 1 ? 'Completed task' : 'Incomplete task')
          }
          if (item.prefix) { Text(item.prefix).fontSize(16).fontColor(this.colors.text).width(item.prefix === '•' ? 12 : 22).alignSelf(ItemAlign.Start) }
          Column() { this.content(item) }.layoutWeight(1)
        }.width('100%').alignItems(VerticalAlign.Top)
          .onAreaChange((_old: Area, area: Area) => { if (item.anchor !== undefined) this.onHeading(item.anchor, Number(area.position.y)); })
          .padding({ left: Math.max(0, item.indent - 1) * 16 + (item.quote ? 14 : 0), right: item.quote ? 12 : 0, top: item.quote ? 10 : 0, bottom: item.quote ? 10 : 0 })
          .border({ width: { left: item.quote ? 3 : 0 }, color: this.token('border-quote') })
          .backgroundColor(item.quote ? this.token('surface-info') : Color.Transparent)
          .borderRadius({ topRight: item.quote ? this.colors.radius : 0, bottomRight: item.quote ? this.colors.radius : 0 })
          .margin({ bottom: this.gap(item, index) })
      })
    }.width('100%').alignItems(HorizontalAlign.Start)
  }
}
