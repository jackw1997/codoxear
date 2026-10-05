import { Palette, themeVariables } from './Theme';
import { nativeCss } from '../vendor/css';
export interface ComponentStyle {
  background: string; color: string; fontSize: number; lineHeight: number;
  paddingTop: number; paddingRight: number; paddingBottom: number; paddingLeft: number;
  radius: number; borderWidth: number; borderColor: string; maxWidth: number;
}
export interface MessageStyles { user: ComponentStyle; assistant: ComponentStyle; }
export interface StyleResult { palette: Palette; components: MessageStyles; warnings: string[]; }
export function applyNativeStyle(css: string, base: Palette, width: number): StyleResult {
  return JSON.parse(nativeCss(css, JSON.stringify(base), JSON.stringify(themeVariables(base.family, base.mode === 'dark')), width)) as StyleResult;
}
