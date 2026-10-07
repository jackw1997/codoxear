export interface HintBounds { x: number; y: number; width: number; height: number; }
export interface HintControl {
  id: number; label: string; scope: string; preferred: string; session: boolean; button?: boolean;
  bounds: HintBounds; visible: boolean; enabled: () => boolean; activate: () => void;
}
export interface HintBadge { id: number; label: string; target: string; x: number; y: number; }

@Observed
export class KeyboardHints {
  badges: HintBadge[] = [];
  sequence: number = 0;
  private controls: Map<number, HintControl> = new Map();
  private targets: Map<string, number> = new Map();
  private prefix: string = '';
  private focused: string = '';
  private scopes: string[] = [];
  update(control: HintControl): void {
    const previous = this.controls.get(control.id);
    if (this.active() && previous && this.badges.some((badge: HintBadge) => badge.id === control.id) &&
      (previous.label !== control.label || previous.scope !== control.scope || previous.preferred !== control.preferred || previous.visible !== control.visible || previous.bounds.x !== control.bounds.x || previous.bounds.y !== control.bounds.y || previous.bounds.width !== control.bounds.width || previous.bounds.height !== control.bounds.height)) this.exit();
    this.controls.set(control.id, control);
  }
  remove(id: number): void { this.controls.delete(id); if (this.badges.some((badge: HintBadge) => badge.id === id)) this.exit(); }
  focus(id: string): void { this.focused = id; this.exit(); }
  blur(id: string): void { if (this.focused === id) this.focused = ''; }
  typing(): boolean { return !!this.focused; }
  active(): boolean { return this.badges.length > 0; }
  dialogKey(key: string, viewport: HintBounds): boolean {
    if (this.typing() || this.active() || !/^[a-z0-9]$/i.test(key)) return false;
    const controls = Array.from(this.controls.values()).filter((control: HintControl) => {
      const box = control.bounds;
      return control.scope === 'panel' && control.button && control.visible && control.enabled() && box.width > 0 && box.height > 0 &&
        box.x < viewport.x + viewport.width && box.x + box.width > viewport.x && box.y < viewport.y + viewport.height && box.y + box.height > viewport.y;
    });
    const labels = controls.map((control: HintControl) => control.label.trim().toLowerCase());
    const target = controls.find((_control: HintControl, index: number) => {
      const label = labels[index];
      for (let position = 0; position < label.length; position++) {
        const candidate = label[position];
        if (/^[a-z0-9]$/.test(candidate) && labels.filter((other: string) => other[position] === candidate).length === 1) return candidate === key.toLowerCase();
      }
      return false;
    });
    if (!target) return false;
    target.activate(); return true;
  }
  exit(): void { this.badges = []; this.targets.clear(); this.prefix = ''; }
  enter(scopes: string[], viewport: HintBounds): boolean {
    this.exit(); if (this.typing()) return false;
    this.scopes = scopes;
    const controls = Array.from(this.controls.values()).filter((control: HintControl) => {
      const box = control.bounds;
      return scopes.includes(control.scope) && control.visible && control.enabled() && box.width > 0 && box.height > 0 &&
        box.x < viewport.x + viewport.width && box.x + box.width > viewport.x && box.y < viewport.y + viewport.height && box.y + box.height > viewport.y;
    }).sort((a: HintControl, b: HintControl) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
    const used: string[] = ['f']; let session = 0; let overflow = 0;
    const assign = (control: HintControl, label: string): void => { this.targets.set(label, control.id); used.push(label); };
    controls.filter((control: HintControl) => control.session).slice(0, 9).forEach((control: HintControl) => assign(control, '' + (++session)));
    controls.forEach((control: HintControl) => {
      if (control.preferred && control.preferred !== 'f' && !used.includes(control.preferred) && !Array.from(this.targets.values()).includes(control.id)) assign(control, control.preferred);
    });
    controls.forEach((control: HintControl) => {
      if (Array.from(this.targets.values()).includes(control.id)) return;
      const candidates = (control.label.toLowerCase() + 'abcdefghijklmnopqrstuvwxyz').split('');
      let label = candidates.find((value: string) => /^[a-z]$/.test(value) && !used.includes(value));
      if (!label) { const alphabet = 'abcdefghijklmnopqrstuvwxyz'; label = 'f' + alphabet.charAt(Math.floor(overflow / 26)) + alphabet.charAt(overflow % 26); overflow++; }
      assign(control, label);
    });
    this.badges = Array.from(this.targets.keys()).map((label: string): HintBadge => {
      const control = this.controls.get(this.targets.get(label)!)!;
      return { id: control.id, label: label, target: control.label, x: Math.max(0, control.bounds.x - viewport.x), y: Math.max(0, control.bounds.y - viewport.y) };
    });
    return this.active();
  }
  key(key: string): boolean {
    if (!this.active()) return false;
    if (key === 'Escape' || key === 'Backspace') { this.exit(); return true; }
    const next = this.prefix + key.toLowerCase();
    const matches = Array.from(this.targets.keys()).filter((label: string) => label.startsWith(next));
    if (!matches.length) { this.exit(); return false; }
    this.prefix = next;
    const id = this.targets.get(next);
    if (id === undefined || matches.length > 1) return true;
    const control = this.controls.get(id);
    this.exit();
    if (control && control.visible && control.enabled() && this.scopes.includes(control.scope)) control.activate();
    return true;
  }
}
