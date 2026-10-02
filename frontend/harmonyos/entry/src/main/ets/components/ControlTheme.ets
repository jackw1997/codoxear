import { Palette } from '../model/Theme';

export class ToggleTheme implements AttributeModifier<ToggleAttribute> {
  private colors: Palette;
  private on: boolean;
  constructor(colors: Palette, on: boolean) { this.colors = colors; this.on = on; }
  applyNormalAttribute(control: ToggleAttribute): void {
    control.selectedColor(this.colors.primary).switchStyle({ unselectedColor: this.colors.hairline })
      .switchPointColor(this.on ? this.colors.onPrimary : this.colors.text);
  }
}
