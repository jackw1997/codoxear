import { Palette, palette } from '../model/Theme';

@Component
export struct VideoViewer {
  @Prop @Watch('sourceChanged') path: string = '';
  @Prop colors: Palette = palette('clay', false);
  @Prop contentHeight: number = 420;
  @State failed: boolean = false;
  private sourceChanged(): void { this.failed = false; }
  build() {
    Column() {
      if (this.failed) {
        Text('Unable to play this video. The file may be damaged or use an unsupported format.').fontColor(this.colors.danger).padding(12)
      }
      Video({ src: 'file://' + this.path }).width('100%').layoutWeight(1).objectFit(ImageFit.Contain).backgroundColor(Color.Black).controls(true).autoPlay(false)
        .onError(() => { this.failed = true; })
    }.width('100%').height(this.contentHeight)
  }
}
