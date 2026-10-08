import { Startup } from '../model/Startup';
@Entry
@Component
struct Unlock {
  @State startup: Startup = AppStorage.get<Startup>('codoxearNativeStartup')!;
  @State busy: boolean = false;
  build() {
    Column({space: 16}) {
      Text('Codoxear').fontSize(24).fontWeight(FontWeight.Bold).fontColor('#322d27')
      Text(this.startup.error).fontColor('#322d27')
      Button('Try again after unlocking').height(48).enabled(!this.busy).onClick(() => {
        this.busy = true;
        void this.startup.retry().catch(error => { this.startup.error = error.message; }).finally(() => { this.busy = false; });
      })
    }.padding(24).width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor('#f4f0e8')
  }
}
