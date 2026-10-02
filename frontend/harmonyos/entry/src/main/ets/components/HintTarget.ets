import { KeyboardHints, HintBounds } from '../model/KeyboardHints';

@Component
export struct HintTarget {
  @Consume nativeHints: KeyboardHints;
  @Prop @Watch('update') label: string = '';
  @Prop @Watch('update') scope: string = 'panel';
  @Prop @Watch('update') preferred: string = '';
  @Prop @Watch('update') session: boolean = false;
  @Prop @Watch('update') button: boolean = false;
  @Prop @Watch('update') available: boolean = true;
  activate: () => void = () => {};
  @BuilderParam content: () => void;
  private identity: number = 0;
  private visible: boolean = false;
  private bounds: HintBounds = { x: 0, y: 0, width: 0, height: 0 };
  aboutToAppear(): void { this.identity = ++this.nativeHints.sequence; }
  aboutToDisappear(): void { this.nativeHints.remove(this.identity); }
  private update(): void {
    this.nativeHints.update({ id: this.identity, label: this.label, scope: this.scope, preferred: this.preferred,
      session: this.session, button: this.button, bounds: this.bounds, visible: this.visible, enabled: () => this.available, activate: () => this.activate() });
  }
  build() {
    Stack() { this.content() }
      .onAreaChange((_old: Area, area: Area) => {
        this.bounds = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y), width: Number(area.width), height: Number(area.height) }; this.update();
      })
      .onVisibleAreaChange([0, 1], (visible: boolean, ratio: number) => { this.visible = visible && ratio > 0; this.update(); })
  }
}
