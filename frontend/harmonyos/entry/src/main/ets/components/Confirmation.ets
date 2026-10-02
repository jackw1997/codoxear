import { LengthMetrics } from '@kit.ArkUI';
import { Palette, palette } from '../model/Theme';
import { KeyboardHints, HintBadge, HintBounds } from '../model/KeyboardHints';
import { HintTarget } from './HintTarget';

export interface ConfirmationButton { value: string; action: () => void; }
export interface ConfirmationOptions {
  title: string;
  message: string;
  primaryButton: ConfirmationButton;
  secondaryButton: ConfirmationButton;
}

@CustomDialog
export struct Confirmation {
  controller?: CustomDialogController;
  options: ConfirmationOptions = { title: '', message: '', primaryButton: { value: 'Cancel', action: () => {} }, secondaryButton: { value: 'Confirm', action: () => {} } };
  colors: Palette = palette('clay', false);
  @Provide({ allowOverride: 'nativeHints' }) nativeHints: KeyboardHints = new KeyboardHints();
  private viewport: HintBounds = { x: 0, y: 0, width: 0, height: 0 };
  private meta: boolean = false;
  private settled: boolean = false;

  private choose(button: ConfirmationButton): void {
    if (this.settled) return;
    this.settled = true; this.nativeHints.exit(); this.controller?.close(); button.action();
  }
  private handleKey(event: KeyEvent): void {
    if (event.keyCode === 2076 || event.keyCode === 2077) { this.meta = event.type === KeyType.Down; return; }
    if (event.type !== KeyType.Down || this.meta || event.getModifierKeyState?.(['ctrl']) || event.getModifierKeyState?.(['alt'])) return;
    const key = event.keyCode >= 2017 && event.keyCode <= 2042 ? String.fromCharCode(97 + event.keyCode - 2017) : event.keyCode === 2070 ? 'Escape' : event.keyCode === 2055 ? 'Backspace' : event.keyText;
    if (this.nativeHints.active()) { this.nativeHints.key(key); event.stopPropagation(); return; }
    if (key === 'Escape') { event.stopPropagation(); return; }
    if (key === 'f' && !event.getModifierKeyState?.(['shift'])) { this.nativeHints.enter(['panel'], this.viewport); event.stopPropagation(); return; }
    if (this.nativeHints.dialogKey(key, this.viewport)) event.stopPropagation();
  }
  @Builder
  choice(button: ConfirmationButton, primary: boolean) {
    HintTarget({ label: button.value, button: true, activate: () => { this.choose(button); } }) {
      Button(button.value, { type: ButtonType.Normal }).id(primary ? 'confirmation-accept' : 'confirmation-cancel')
        .defaultFocus(!primary).height(40).padding({ left: 14, right: 14 }).fontSize(13).fontWeight(FontWeight.Normal)
        .backgroundColor(primary ? this.colors.primary : this.colors.paper).fontColor(primary ? this.colors.onPrimary : this.colors.text)
        .border({ width: 1, color: primary ? this.colors.primary : this.colors.hairline }).borderRadius(this.colors.radius)
        .onClick(() => { this.choose(button); })
    }
  }
  build() {
    Stack() {
      Column({ space: 18 }) {
        Text(this.options.title).fontSize(18).fontWeight(FontWeight.Medium).fontColor(this.colors.text).width('100%')
        Text(this.options.message).fontSize(14).fontColor(this.colors.muted).width('100%')
        Flex({ justifyContent: FlexAlign.End, wrap: FlexWrap.Wrap, space: { main: LengthMetrics.vp(10), cross: LengthMetrics.vp(10) } }) {
          this.choice(this.options.primaryButton, false)
          this.choice(this.options.secondaryButton, true)
        }.width('100%')
      }.padding(22).width('100%').backgroundColor(this.colors.paper).border({ width: 1, color: this.colors.hairline }).borderRadius(this.colors.cardRadius)
      ForEach(this.nativeHints.badges, (badge: HintBadge) => {
        Text(badge.label).id('hint-' + badge.label).accessibilityDescription(badge.target).fontFamily('monospace').fontSize(14).fontWeight(FontWeight.Bold)
          .fontColor('#ffffff').backgroundColor('#141111').padding({ left: 4, right: 4, top: 1, bottom: 1 })
          .position({ x: badge.x, y: badge.y }).hitTestBehavior(HitTestMode.None)
      }, (badge: HintBadge) => '' + badge.id)
    }.width('92%').constraintSize({ maxWidth: 440 }).onKeyEvent((event: KeyEvent) => { this.handleKey(event); })
      .onTouch((event: TouchEvent) => { if (event.type === TouchType.Down) this.nativeHints.exit(); })
      .onAreaChange((_old: Area, area: Area) => {
        this.viewport = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y), width: Number(area.width), height: Number(area.height) };
      })
  }
}
