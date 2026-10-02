import { Palette, palette } from '../model/Theme';
import { HintTarget } from './HintTarget';

@Component
export struct ImageViewer {
  @Prop @Watch('sourceChanged') path: string = '';
  @Prop colors: Palette = palette('clay', false);
  @Prop contentHeight: number = 420;
  @State zoom: number = 1;
  @State failed: boolean = false;
  @State offsetX: number = 0;
  @State offsetY: number = 0;
  private imageWidth: number = 0;
  private imageHeight: number = 0;
  private startZoom: number = 1;
  private startX: number = 0;
  private startY: number = 0;
  private viewportWidth: number = 1;
  private viewportHeight: number = 1;
  private sourceChanged(): void { this.failed = false; this.imageWidth = 0; this.imageHeight = 0; this.reset(); }
  private reset(): void { this.zoom = 1; this.offsetX = 0; this.offsetY = 0; }
  private clamp(): void {
    const fit = this.imageWidth > 0 && this.imageHeight > 0 ? Math.min(this.viewportWidth / this.imageWidth, this.viewportHeight / this.imageHeight) : 1;
    const width = this.imageWidth > 0 ? this.imageWidth * fit : this.viewportWidth;
    const height = this.imageHeight > 0 ? this.imageHeight * fit : this.viewportHeight;
    const x = Math.max(0, (width * this.zoom - this.viewportWidth) / 2);
    const y = Math.max(0, (height * this.zoom - this.viewportHeight) / 2);
    this.offsetX = Math.max(-x, Math.min(x, this.offsetX));
    this.offsetY = Math.max(-y, Math.min(y, this.offsetY));
  }
  private setZoom(value: number): void { this.zoom = Math.max(1, Math.min(8, value)); this.clamp(); }
  @Builder
  action(label: string, action: () => void) {
    HintTarget({ label: label, button: true, available: !this.failed, activate: action }) {
    Button(label, { type: ButtonType.Normal }).height(32).constraintSize({ minWidth: 44 }).responseRegion({ x: 0, y: -6, width: '100%', height: 44 }).fontSize(12).padding({ left: 12, right: 12 })
      .fontColor(this.colors.text).backgroundColor(this.colors.subtle).borderRadius(this.colors.radius).enabled(!this.failed).onClick(action)
    }
  }
  build() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        this.action('−', () => { this.setZoom(this.zoom / 1.5); })
        Text(Math.round(this.zoom * 100) + '%').fontSize(12).fontColor(this.colors.text).layoutWeight(1).textAlign(TextAlign.Center)
        this.action('+', () => { this.setZoom(this.zoom * 1.5); })
        this.action('Fit image', () => { this.reset(); })
      }.width('100%').height(44)
      if (this.failed) { Text('Unable to open this image. The file may be damaged or unsupported.').fontColor(this.colors.danger).padding(12) }
      Stack() {
        Image('file://' + this.path).id('image-preview').onComplete((event) => { if (event) { this.imageWidth = event.width; this.imageHeight = event.height; this.clamp(); } }).onError(() => { this.failed = true; }).width('100%').height('100%').objectFit(ImageFit.Contain)
          .scale({ x: this.zoom, y: this.zoom }).translate({ x: this.offsetX, y: this.offsetY })
      }.id('image-viewport').width('100%').layoutWeight(1).clip(true).backgroundColor(this.colors.subtle)
        .onAreaChange((_old, area) => { this.viewportWidth = Number(area.width); this.viewportHeight = Number(area.height); this.clamp(); })
        .gesture(GestureGroup(GestureMode.Parallel,
          PinchGesture().onActionStart(() => { this.startZoom = this.zoom; })
            .onActionUpdate((event: GestureEvent) => { this.setZoom(this.startZoom * event.scale); }),
          PanGesture({ fingers: 1 }).onActionStart(() => { this.startX = this.offsetX; this.startY = this.offsetY; })
            .onActionUpdate((event: GestureEvent) => {
              this.offsetX = this.startX + event.offsetX; this.offsetY = this.startY + event.offsetY; this.clamp();
            }),
          TapGesture({ count: 2 }).onAction(() => { if (this.zoom > 1) this.reset(); else this.setZoom(2); })
        ))
    }.width('100%').height(this.contentHeight)
  }
}
