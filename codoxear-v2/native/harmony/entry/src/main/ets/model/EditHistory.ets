interface EditStep { offset: number; removed: string; inserted: string; }

// Keep the changed ranges rather than 100 complete copies of a large document.
export class EditHistory {
  private past: EditStep[] = [];
  private future: EditStep[] = [];
  private value: string = '';
  private grouped: boolean = false;
  private changedAt: number = 0;
  reset(text: string): void { this.value = text; this.past = []; this.future = []; this.grouped = false; }
  change(text: string, typing: boolean = false): void {
    if (text === this.value) return;
    let start = 0;
    const common = Math.min(text.length, this.value.length);
    // Compare unchanged blocks in the runtime's native string implementation.
    // A single key near the end of a large file must not run a JS iteration
    // for every preceding code unit. Finish the boundary exactly for undo.
    const block = 4096;
    while (start + block <= common && text.slice(start, start + block) === this.value.slice(start, start + block)) start += block;
    while (start < common && text.charCodeAt(start) === this.value.charCodeAt(start)) start++;
    let oldEnd = this.value.length;
    let newEnd = text.length;
    while (oldEnd - block >= start && newEnd - block >= start && text.slice(newEnd - block, newEnd) === this.value.slice(oldEnd - block, oldEnd)) { oldEnd -= block; newEnd -= block; }
    while (oldEnd > start && newEnd > start && this.value.charCodeAt(oldEnd - 1) === text.charCodeAt(newEnd - 1)) { oldEnd--; newEnd--; }
    const step: EditStep = { offset: start, removed: this.value.slice(start, oldEnd), inserted: text.slice(start, newEnd) };
    const previous = this.past[this.past.length - 1];
    const now = Date.now();
    let merged = false;
    if (typing && this.grouped && previous && now - this.changedAt <= 750) {
      if (!previous.removed && !step.removed && previous.offset + previous.inserted.length === step.offset) {
        previous.inserted += step.inserted; merged = true;
      } else if (!previous.inserted && !step.inserted && step.offset + step.removed.length === previous.offset) {
        previous.offset = step.offset; previous.removed = step.removed + previous.removed; merged = true;
      } else if (!previous.inserted && !step.inserted && step.offset === previous.offset) {
        previous.removed += step.removed; merged = true;
      }
    }
    if (!merged) this.past.push(step);
    this.grouped = typing; this.changedAt = now;
    if (this.past.length > 100) this.past.shift();
    this.value = text;
    this.future = [];
  }
  undo(): string {
    this.grouped = false;
    const step = this.past.pop();
    if (step) {
      this.value = this.value.slice(0, step.offset) + step.removed + this.value.slice(step.offset + step.inserted.length);
      this.future.push(step);
    }
    return this.value;
  }
  redo(): string {
    this.grouped = false;
    const step = this.future.pop();
    if (step) {
      this.value = this.value.slice(0, step.offset) + step.inserted + this.value.slice(step.offset + step.removed.length);
      this.past.push(step);
    }
    return this.value;
  }
}
