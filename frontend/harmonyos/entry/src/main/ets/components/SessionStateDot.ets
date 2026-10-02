import { accessibility } from '@kit.AccessibilityKit';
import { Palette, palette, themeVariables } from '../model/Theme';

@Component
export struct SessionStateDot {
  @Prop colors: Palette = palette('clay', false);
  @Prop @Watch('refresh') busy: boolean = false;
  @Prop @Watch('refresh') pending: boolean = false;
  @Prop @Watch('refresh') suppressed: boolean = false;
  @Prop label: string = 'Idle';
  @State private opacityValue: number = 1;
  @State private scaleValue: number = 1;
  private visible: boolean = false;
  private reduced: boolean = false;
  private reducedChanged = (value: boolean): void => { this.reduced = value; this.refresh(); };
  aboutToAppear(): void {
    try {
      this.reduced = accessibility.isAnimationReduceEnabledSync();
      accessibility.onAnimationReduceStateChange(this.reducedChanged);
    } catch (_) { this.reduced = true; }
  }
  aboutToDisappear(): void {
    this.visible = false; this.refresh();
    try { accessibility.offAnimationReduceStateChange(this.reducedChanged); } catch (_) {}
  }
  private refresh(): void {
    this.getUIContext().animateTo({ duration: 0 }, () => { this.opacityValue = 1; this.scaleValue = 1; });
    if (this.visible && !this.reduced && (this.pending || (this.busy && !this.suppressed))) {
      this.getUIContext().animateTo({ duration: 900, curve: Curve.EaseInOut, iterations: -1, playMode: PlayMode.Alternate }, () => {
        this.opacityValue = 0.55; this.scaleValue = 0.72;
      });
    }
  }
  build() {
    Stack() {}.width(9).height(9).borderRadius(this.colors.family === 'paper' ? 0 : 5)
      .border({ width: 2, color: this.colors.ink })
      .backgroundColor(this.pending ? themeVariables(this.colors.family, this.colors.mode === 'dark')['state-pending'] : this.busy || this.suppressed ? this.colors.ink : Color.Transparent)
      .opacity(this.opacityValue).scale({ x: this.scaleValue, y: this.scaleValue })
      .accessibilityText(this.label)
      .onVisibleAreaChange([0, 1], (visible: boolean, ratio: number) => {
        const next = visible && ratio > 0;
        if (next !== this.visible) { this.visible = next; this.refresh(); }
      })
  }
}
