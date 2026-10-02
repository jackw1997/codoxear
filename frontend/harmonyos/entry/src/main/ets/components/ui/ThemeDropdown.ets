import { Palette, palette } from '../../model/Theme';

// App-owned trigger and option list. The popup only positions our content;
// no Select/Menu control supplies colors, shapes, labels, or selection behavior.
@Component
export struct ThemeDropdown {
  @Prop colors: Palette = palette('clay', false);
  @Prop options: string[] = [];
  @Prop value: string = '';
  @Prop placeholder: string = 'Select an option';
  @Prop label: string = '';
  @Prop controlId: string = '';
  @Prop selectedIndex: number = -1;
  @Prop disabled: boolean = false;
  onSelect: (index: number, value: string) => void = () => {};
  @State private expanded: boolean = false;
  @State private active: number = -1;
  @State private focused: boolean = false;
  @State private controlWidth: number = 240;
  private scroller: Scroller = new Scroller();

  private selected(index: number): boolean {
    return this.selectedIndex >= 0 ? this.selectedIndex === index : this.options[index] === this.value;
  }
  private open(): void {
    if (this.disabled || !this.options.length) return;
    this.active = Math.max(0, this.selectedIndex >= 0 ? this.selectedIndex : this.options.indexOf(this.value));
    this.expanded = true;
    setTimeout(() => { if (this.expanded) this.focusOption(); }, 80);
  }
  private close(): void {
    this.expanded = false;
    setTimeout(() => { focusControl.requestFocus(this.controlId); }, 20);
  }
  private choose(index: number): void {
    this.onSelect(index, this.options[index]);
    this.close();
  }
  private focusOption(): void {
    this.scroller.scrollToIndex(this.active);
    focusControl.requestFocus(this.controlId + '-option-' + this.active);
  }
  private handleKey(event: KeyEvent): void {
    if (event.type !== KeyType.Down) return;
    if (event.keyCode === 2054 || event.keyCode === 2050) {
      if (this.expanded && this.active >= 0) this.choose(this.active); else this.open();
      event.stopPropagation();
    }
    else if (event.keyCode === 2070 && this.expanded) { this.close(); event.stopPropagation(); }
    else if (event.keyCode === 2012 || event.keyCode === 2013) {
      if (!this.expanded) this.open();
      else { this.active = Math.max(0, Math.min(this.options.length - 1, this.active + (event.keyCode === 2013 ? 1 : -1))); this.focusOption(); }
      event.stopPropagation();
    }
  }
  @Builder
  menu() {
    List({ scroller: this.scroller }) {
      ForEach(this.options, (option: string, index: number) => {
        ListItem() {
          Button({ type: ButtonType.Normal }) {
            Row({ space: 10 }) {
              Text(option).fontSize(14).fontColor(this.selected(index) ? this.colors.onPrimary : this.colors.text)
                .layoutWeight(1).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }).textAlign(TextAlign.Start)
              Text(this.selected(index) ? '✓' : '').fontSize(16).fontColor(this.colors.onPrimary).width(18)
            }.width('100%').padding({ left: 12, right: 12 })
          }.id(this.controlId + '-option-' + index).width('100%').height(44)
            .backgroundColor(this.selected(index) ? this.colors.primary : this.active === index ? this.colors.wash : this.colors.paper)
            .borderRadius(this.colors.radius).stateEffect(false)
            .accessibilityText(option + (this.selected(index) ? ', selected' : ''))
            .onHover((hover: boolean) => { if (hover) this.active = index; })
            .onFocus(() => { this.active = index; })
            .onClick(() => { this.choose(index); }).onKeyEvent((event: KeyEvent) => { this.handleKey(event); })
        }
      }, (_option: string, index: number) => '' + index)
    }.id(this.controlId + '-menu').width(this.controlWidth).height(Math.min(6, this.options.length) * 44 + 8)
      .padding(4).backgroundColor(this.colors.paper).border({ width: 1, color: this.colors.hairline })
      .borderRadius(this.colors.radius).clip(true).scrollBar(BarState.Off)
  }
  build() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Text(this.value || this.placeholder).fontSize(14).fontColor(this.value ? this.colors.text : this.colors.muted)
          .layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).textAlign(TextAlign.Start)
        Polyline().points([[2, 5], [7, 10], [12, 5]]).width(14).height(14)
          .fill(Color.Transparent).stroke(this.colors.muted).strokeWidth(1.5).rotate({ angle: this.expanded ? 180 : 0 })
      }.width('100%').padding({ left: 12, right: 12 })
    }.id(this.controlId).width('100%').height(44).stateEffect(false)
      .backgroundColor(this.colors.paper)
      .border({ width: 1, color: this.focused || this.expanded ? this.colors.primary : this.colors.hairline }).borderRadius(this.colors.radius)
      .enabled(!this.disabled && this.options.length > 0).opacity(this.disabled || !this.options.length ? 0.5 : 1)
      .accessibilityText(this.label + ', ' + (this.value || this.placeholder) + (this.expanded ? ', expanded' : ', collapsed'))
      .onFocus(() => { this.focused = true; }).onBlur(() => { this.focused = false; })
      .onClick(() => { if (this.expanded) this.close(); else this.open(); })
      .onKeyEvent((event: KeyEvent) => { this.handleKey(event); })
      .onAreaChange((_old: Area, area: Area) => { this.controlWidth = Number(area.width); })
      .bindPopup(this.expanded, { builder: this.menu, placement: Placement.Bottom, enableArrow: false,
        popupColor: this.colors.paper, backgroundBlurStyle: BlurStyle.NONE, radius: this.colors.radius,
        shadow: { radius: 0, color: Color.Transparent }, targetSpace: 4, autoCancel: true, focusable: true,
        onStateChange: (event) => { this.expanded = event.isVisible; } })
  }
}
