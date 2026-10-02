import { common } from '@kit.AbilityKit';
import { text as textLayout } from '@kit.ArkGraphics2D';
import { InlinePart } from '../model/Markdown';
import { Palette, palette, themeVariables } from '../model/Theme';
import { KeyboardHints, HintBounds } from '../model/KeyboardHints';
import { MathAsset, mathAsset } from '../services/MathAsset';

// A native Text owns both its span rendering and the SDK layout used for hints.
// Range rectangles follow actual shaping/wrapping, including Unicode text.
@Component
export struct NativeInline {
  @Consume nativeHints: KeyboardHints;
  @Prop @Watch('queueHints') parts: InlinePart[] = [];
  @Prop @Watch('queueHints') hintScope: string = 'chat';
  @Prop @Watch('queueHints') hintClip: HintBounds = { x: 0, y: 0, width: 0, height: 0 };
  @Prop colors: Palette = palette('clay', false);
  @Prop textSize: number = 16;
  @Prop bold: boolean = false;
  @Prop lineHeight: number = 1.35;
  @Prop alignment: string = 'left';
  onLink: (url: string) => void = () => {};
  onTap: () => void = () => {};
  private controller: TextController = new TextController();
  private bounds: HintBounds = { x: 0, y: 0, width: 0, height: 0 };
  private identities: Map<string, number> = new Map();
  private visible: boolean = false;
  private alive: boolean = true;
  private timer: number = -1;
  aboutToDisappear(): void {
    this.alive = false; if (this.timer !== -1) clearTimeout(this.timer);
    this.identities.forEach((id: number) => this.nativeHints.remove(id)); this.identities.clear();
  }
  private formula(latex: string, highlight: boolean = false): MathAsset {
    return mathAsset(latex, this.colors.text, false, (getContext(this) as common.UIAbilityContext).cacheDir,
      highlight ? themeVariables(this.colors.family, this.colors.mode === 'dark')['surface-highlight'] : '');
  }
  private queueHints(): void {
    if (this.timer !== -1) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = -1; if (this.alive) this.refreshHints(); }, 30);
  }
  private refreshHints(): void {
    const retained: string[] = []; let offset = 0;
    for (let index = 0; index < this.parts.length; index++) {
      const part = this.parts[index]; const start = offset;
      const image = !!part.math && !!this.formula(part.math).source;
      offset += image ? 1 : part.text.length;
      if (!part.url || image) continue;
      let label = part.text;
      while (index + 1 < this.parts.length && this.parts[index + 1].url === part.url && !this.parts[index + 1].math) {
        index++; label += this.parts[index].text; offset += this.parts[index].text.length;
      }
      const key = start + ':' + part.url; retained.push(key);
      let identity = this.identities.get(key);
      if (identity === undefined) { identity = ++this.nativeHints.sequence; this.identities.set(key, identity); }
      let box: HintBounds = { x: 0, y: 0, width: 0, height: 0 };
      if (this.visible && this.hintClip.width > 0 && this.hintClip.height > 0) {
        try {
          const rectangles = this.controller.getLayoutManager().getRectsForRange({ start: start, end: offset }, textLayout.RectWidthStyle.TIGHT, textLayout.RectHeightStyle.TIGHT);
          for (const item of rectangles) {
            const x = Math.max(this.hintClip.x, this.bounds.x + this.getUIContext().px2vp(item.rect.left));
            const y = Math.max(this.hintClip.y, this.bounds.y + this.getUIContext().px2vp(item.rect.top));
            const right = Math.min(this.hintClip.x + this.hintClip.width, this.bounds.x + this.getUIContext().px2vp(item.rect.right));
            const bottom = Math.min(this.hintClip.y + this.hintClip.height, this.bounds.y + this.getUIContext().px2vp(item.rect.bottom));
            if (right > x && bottom > y) { box = { x: x, y: y, width: right - x, height: bottom - y }; break; }
          }
        } catch (_) { /* A text node without a completed native layout has no target yet. */ }
      }
      this.nativeHints.update({ id: identity, label: label, scope: this.hintScope, preferred: '', session: false,
        bounds: box, visible: this.visible && box.width > 0, enabled: () => this.alive, activate: () => this.onLink(part.url) });
    }
    Array.from(this.identities.keys()).forEach((key: string) => {
      if (!retained.includes(key)) { this.nativeHints.remove(this.identities.get(key)!); this.identities.delete(key); }
    });
  }
  build() {
    Text(undefined, { controller: this.controller }) {
      ForEach(this.parts, (part: InlinePart) => {
        if (part.math && this.formula(part.math).source) {
          ImageSpan(this.formula(part.math, !!part.highlight).source).width(this.formula(part.math).width).height(this.formula(part.math).height).verticalAlign(ImageSpanAlignment.CENTER)
        } else {
          Span(part.text).fontWeight(part.bold || this.bold ? FontWeight.Bold : FontWeight.Normal)
            .fontStyle(part.italic ? FontStyle.Italic : FontStyle.Normal).fontFamily(part.code ? 'monospace' : 'HarmonyOS Sans')
            .fontSize(part.code ? 13 : part.choice ? this.textSize * 0.78 : this.textSize).fontColor(part.choice ? this.colors.muted : this.colors.text)
            .textBackgroundStyle({ color: part.highlight ? themeVariables(this.colors.family, this.colors.mode === 'dark')['surface-highlight'] : part.code ? this.colors.code : part.choice ? this.colors.wash : Color.Transparent, radius: part.code || part.choice ? this.colors.radius : 0 })
            .decoration({ type: part.strike ? TextDecorationType.LineThrough : part.url && !part.choice ? TextDecorationType.Underline : TextDecorationType.None, color: this.colors.text })
            .onClick(() => { if (part.url) this.onLink(part.url); else this.onTap(); })
        }
      })
    }.fontSize(this.textSize).lineHeight(this.textSize * this.lineHeight).copyOption(CopyOptions.LocalDevice).width('100%')
      .textAlign(this.alignment === 'right' ? TextAlign.End : this.alignment === 'center' ? TextAlign.Center : TextAlign.Start)
      .onAreaChange((_old: Area, area: Area) => { this.bounds = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y), width: Number(area.width), height: Number(area.height) }; this.queueHints(); })
      .onVisibleAreaChange([0, 0.25, 0.5, 0.75, 1], (visible: boolean, ratio: number) => { this.visible = visible && ratio > 0; this.queueHints(); })
  }
}
