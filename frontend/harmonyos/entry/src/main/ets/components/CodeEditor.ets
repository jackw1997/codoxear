import { HintTarget } from './HintTarget';
import { KeyboardHints, HintBounds } from '../model/KeyboardHints';
import { MarkdownView } from './MarkdownView';
import { editAtCursor, moveCursor } from '../model/EditorMotion';
import { LengthMetrics } from '@kit.ArkUI';
import { Workspace, FileViewState } from '../model/Workspace';
import { Palette } from '../model/Theme';
import { FileSource } from './FileSource';

@Component
export struct CodeEditor {
  @State hintClip: HintBounds = { x: 0, y: 0, width: 0, height: 0 };
  @Consume nativeHints: KeyboardHints;
  @ObjectLink workspace: Workspace;
  @Prop colors: Palette;
  @Prop contentHeight: number = 300;
  @State @Watch('remember') editing: boolean = false;
  @State @Watch('remember') preview: boolean = true;
  @Prop @Watch('navigate') location: string = '';
  onLink: (url: string) => void = () => {};
  onCopy: (text: string) => void = () => {};
  onSave: () => void = () => {};
  @State @Watch('remember') finding: boolean = false;
  @State @Watch('remember') comparing: boolean = false;
  @State @Watch('remember') query: string = '';
  @State @Watch('remember') replacement: string = '';
  @State bodyHeight: number = 300;
  @State matches: number = 0;
  @State @Watch('remember') matchIndex: number = -1;
  @State @Watch('remember') normal: boolean = false;
  @State @Watch('remember') cursor: number = 0;
  private prefix: string = '';
  private composing: boolean = false;
  private metaDown: boolean = false;
  private sourceScroller: Scroller = new Scroller();
  private previewScroller: Scroller = new Scroller();
  private headings: Map<string, number> = new Map();
  private controller: TextAreaController = new TextAreaController();
  private savedView: FileViewState = new FileViewState();
  private alive: boolean = false;
  private restoring: boolean = true;
  private focusRevision: number = 0;
  aboutToAppear(): void {
    this.savedView = this.workspace.fileViewState();
    this.editing = this.savedView.editing; this.preview = this.savedView.preview;
    this.finding = this.savedView.finding; this.comparing = this.savedView.comparing;
    this.query = this.savedView.query; this.replacement = this.savedView.replacement;
    this.matchIndex = this.savedView.matchIndex; this.normal = this.savedView.normal;
    this.cursor = Math.min(this.savedView.cursor, this.workspace.fileText.length);
    this.matches = this.query ? this.workspace.fileText.split(this.query).length - 1 : 0;
    this.workspace.fileHistory(); this.alive = true;
    const sourceY = this.savedView.sourceY; const previewY = this.savedView.previewY;
    if (this.location) { this.restoring = false; this.navigate(); }
    else setTimeout(() => {
      if (!this.alive) return;
      if (this.editing && !this.normal) this.controller.caretPosition(this.cursor);
      else if (this.preview && this.workspace.activeFile?.kind === 'markdown') this.previewScroller.scrollTo({ xOffset: 0, yOffset: previewY });
      else this.sourceScroller.scrollTo({ xOffset: 0, yOffset: sourceY });
      if (this.editing && this.normal) focusControl.requestFocus('file-keyboard');
      this.restoring = false;
    }, 100);
  }
  aboutToDisappear(): void { this.remember(); this.alive = false; }
  private remember(): void {
    if (!this.alive) return;
    // Keep the original state's identity across a tab change or logout. A late
    // disappearing component must not write into the newly selected file.
    this.savedView.editing = this.editing; this.savedView.preview = this.preview;
    this.savedView.finding = this.finding; this.savedView.comparing = this.comparing;
    this.savedView.query = this.query; this.savedView.replacement = this.replacement;
    this.savedView.matchIndex = this.matchIndex; this.savedView.normal = this.normal;
    this.savedView.cursor = this.cursor;
  }
  private navigate(): void {
    if (!this.location) return;
    const line = this.location.match(/^#L?(\d+)(?:[-:].*)?$/i);
    if (line) {
      this.preview = false; this.editing = false;
      const row = Math.max(0, Math.min(Number(line[1]) - 1, this.workspace.fileText.split('\n').length - 1));
      this.cursor = this.workspace.fileText.split('\n').slice(0, row).reduce((size: number, text: string) => size + text.length + 1, 0);
      setTimeout((): void => { this.sourceScroller.scrollToIndex(row, false, ScrollAlign.START); }, 100);
    } else if (this.workspace.activeFile?.kind === 'markdown') {
      this.preview = true; this.editing = false;
      setTimeout(() => this.anchor(this.location), 100);
    }
  }
  private anchor(url: string): void {
    let id = url.slice(1); try { id = decodeURIComponent(id); } catch (_) {}
    const y = this.headings.get(id);
    if (y !== undefined) this.previewScroller.scrollTo({ xOffset: 0, yOffset: y });
    else this.workspace.notice = 'Heading not found: ' + id;
  }
  private find(): void {
    this.finding = !this.finding;
    if (this.finding) setTimeout(() => focusControl.requestFocus('file-find'), 80);
  }
  private update(text: string, record: boolean = true, typing: boolean = false): void {
    if (!this.workspace.activeFile?.editable) return;
    this.workspace.changeFile(text, record, typing);
    this.matches = this.query ? text.split(this.query).length - 1 : 0;
  }
  private insert(selectionEnd: number = -1): void {
    const start = this.cursor;
    const revision = ++this.focusRevision;
    this.normal = false; this.editing = true; this.prefix = '';
    // Focusing the native field emits selection changes. Capture the intended
    // range before focus so those callbacks cannot move a requested search hit.
    setTimeout(() => {
      if (!this.alive || !this.editing || this.normal || revision !== this.focusRevision) return;
      focusControl.requestFocus('file-editor');
      // Native focus establishes its own caret asynchronously. Apply the range
      // after that transition, otherwise focus overwrites the search selection.
      setTimeout(() => {
        if (!this.alive || !this.editing || this.normal || revision !== this.focusRevision) return;
        if (selectionEnd >= 0) this.controller.setTextSelection(start, selectionEnd, { menuPolicy: MenuPolicy.HIDE });
        else this.controller.caretPosition(start);
      }, 80);
    }, 120);
  }
  private revealCursor(): void {
    const row = this.workspace.fileText.slice(0, this.cursor).split('\n').length - 1;
    this.sourceScroller.scrollToIndex(row, false, ScrollAlign.AUTO);
  }
  private keyboard(event: KeyEvent): boolean {
    if (this.nativeHints.active()) return false;
    if (event.keyCode === 2076 || event.keyCode === 2077) { this.metaDown = event.type === KeyType.Down; return false; }
    if (event.type !== KeyType.Down || this.composing) return false;
    const ctrl = event.getModifierKeyState?.(['ctrl']);
    const meta = this.metaDown;
    const alt = event.getModifierKeyState?.(['alt']);
    const shift = event.getModifierKeyState?.(['shift']);
    const key = event.keyCode >= 2017 && event.keyCode <= 2042 ? String.fromCharCode((shift ? 65 : 97) + event.keyCode - 2017) : event.keyCode === 2000 ? '0' : event.keyCode === 2004 && shift ? '$' : event.keyText;
    if ((ctrl || meta) && !alt && !shift && key === 's') { this.onSave(); return true; }
    if ((ctrl || meta) && !alt && !shift && key === 'f') { this.find(); return true; }
    if (event.keyCode === 2070) {
      if (this.finding) { this.finding = false; setTimeout(() => focusControl.requestFocus('file-keyboard'), 80); return true; }
      this.prefix = '';
      if (this.editing && !this.normal) { this.normal = true; setTimeout(() => { focusControl.requestFocus('file-keyboard'); this.revealCursor(); }, 80); }
      else if (this.editing && !this.workspace.fileDirty) { this.editing = false; this.normal = false; }
      else if (this.editing) this.workspace.notice = 'Unsaved changes';
      return true;
    }
    if (this.editing && !this.normal) {
      if ((ctrl || meta) && !alt && key.toLowerCase() === 'z') { this.update(shift ? this.workspace.fileHistory().redo() : this.workspace.fileHistory().undo(), false); return true; }
      return false;
    }
    if (meta) return false;
    if (this.prefix) {
      const verb = this.prefix + key; this.prefix = '';
      if (!ctrl && !alt && verb === 'gg') this.cursor = 0;
      else if (!ctrl && !alt && verb === 'dd' && this.editing) { const change = editAtCursor(this.workspace.fileText, this.cursor, verb); this.update(change.text); this.cursor = change.cursor; }
      this.revealCursor(); return true;
    }
    if (!ctrl && !alt && (key === 'g' || (key === 'd' && this.editing))) { this.prefix = key; return true; }
    if (ctrl && !alt && (key === 'd' || key === 'u')) { this.cursor = moveCursor(this.workspace.fileText, this.cursor, key === 'd' ? 'j' : 'k', 7); this.revealCursor(); return true; }
    if (this.editing && !alt) {
      if ((!ctrl && key === 'u') || (ctrl && key === 'r')) { this.update(key === 'r' ? this.workspace.fileHistory().redo() : this.workspace.fileHistory().undo(), false); this.cursor = Math.min(this.cursor, this.workspace.fileText.length); this.revealCursor(); return true; }
      if (!ctrl && ['i', 'a', 'A'].includes(key)) { if (key !== 'i') this.cursor = moveCursor(this.workspace.fileText, this.cursor, key === 'A' ? '$' : 'l'); this.insert(); return true; }
      if (!ctrl && ['x', 'o', 'O'].includes(key)) { const change = editAtCursor(this.workspace.fileText, this.cursor, key); this.update(change.text); this.cursor = change.cursor; if (key !== 'x') this.insert(); else this.revealCursor(); return true; }
    }
    if (!ctrl && !alt && ['h','j','k','l','w','b','e','0','$','G'].includes(key)) { this.cursor = moveCursor(this.workspace.fileText, this.cursor, key); this.revealCursor(); return true; }
    return false;
  }
  private findNext(): void {
    if (!this.query) return;
    const text = this.workspace.fileText;
    let index = text.indexOf(this.query, this.matchIndex + 1);
    if (index < 0) index = text.indexOf(this.query);
    this.matchIndex = index;
    this.matches = text.split(this.query).length - 1;
    if (index >= 0) {
      this.cursor = index;
      if (this.editing && this.workspace.activeFile?.editable) { this.insert(index + this.query.length); }
      else { this.preview = false; setTimeout(() => this.revealCursor(), 80); }
    }
  }
  @Builder
  action(label: () => string, action: () => void) {
    HintTarget({ label: label(), activate: action }) {
    Button(label(), { type: ButtonType.Normal }).height(32).constraintSize({ minWidth: 44 }).responseRegion({ x: 0, y: -6, width: '100%', height: 44 }).fontSize(12).padding({ left: 8, right: 8 })
      .fontColor(this.colors.text).backgroundColor(this.colors.subtle).borderRadius(this.colors.radius).onClick(action)
    }
  }
  @Builder
  source(text: () => string, interactive: boolean = true) {
    FileSource({ text: text(), path: this.workspace.activeFile?.path || this.workspace.activeFile?.rel || '', colors: this.colors, cursor: this.cursor, normal: this.normal, contentHeight: this.bodyHeight, interactive: interactive, scroller: interactive ? this.sourceScroller : new Scroller(), onScroll: (y: number) => { if (interactive && this.alive && !this.restoring) this.savedView.sourceY = y; } })
  }
  build() {
    Column({ space: 10 }) {
      Flex({ wrap: FlexWrap.Wrap, space: { main: LengthMetrics.vp(6), cross: LengthMetrics.vp(6) } }) {
        if (this.workspace.activeFile?.editable) { this.action(() => this.editing ? 'View' : 'Edit', () => { if (this.editing) { this.editing = false; this.normal = false; } else this.insert(); this.comparing = false; }) }
        if (this.workspace.activeFile?.kind === 'markdown' && !this.editing) { this.action(() => this.preview ? 'Source' : 'Preview', () => { this.preview = !this.preview; }) }
        this.action(() => 'Find', () => { this.find(); })
        if (this.editing && this.workspace.activeFile?.editable) {
          this.action(() => 'Undo', () => { this.update(this.workspace.fileHistory().undo(), false); })
          this.action(() => 'Redo', () => { this.update(this.workspace.fileHistory().redo(), false); })
        }
        if (this.workspace.fileDirty) { this.action(() => this.comparing ? 'Hide changes' : 'Changes', () => { this.comparing = !this.comparing; }) }
        if (this.editing) { Text(this.normal ? 'NORMAL' : 'INSERT').fontSize(11).fontColor(this.colors.accent).padding(8) }
        Text(this.workspace.fileDirty ? 'Unsaved' : 'Saved').id('file-keyboard').focusable(true).onClick(() => { focusControl.requestFocus('file-keyboard'); }).onBlur(() => { this.metaDown = false; }).onKeyEvent((event: KeyEvent) => { if (this.keyboard(event)) event.stopPropagation(); }).fontSize(11).fontColor(this.colors.muted).padding(8)
      }.width('100%')
      if (this.finding) {
        Row({ space: 6 }) {
          TextInput({ text: this.query, placeholder: 'Find text' }).id('file-find').layoutWeight(1).height(36).fontSize(13).fontColor(this.colors.text).placeholderColor(this.colors.muted).backgroundColor(this.colors.subtle)
          .onFocus(() => { this.nativeHints.focus('file-find'); }).onBlur(() => { this.nativeHints.blur('file-find'); })
            .onSubmit(() => this.findNext()).onKeyPreIme((event: KeyEvent): boolean => event.keyCode === 2070 ? this.keyboard(event) : false)
            .onChange((text: string) => { this.query = text; this.matchIndex = -1; this.matches = text ? this.workspace.fileText.split(text).length - 1 : 0; })
          this.action(() => 'Next', () => { this.findNext(); })
          Text('' + this.matches).fontSize(12).fontColor(this.colors.muted)
        }
        if (this.workspace.activeFile?.editable) {
          Row({ space: 6 }) {
            TextInput({ text: this.replacement, placeholder: 'Replace with' }).id('file-replace').layoutWeight(1).height(36).fontSize(13).fontColor(this.colors.text).placeholderColor(this.colors.muted).backgroundColor(this.colors.subtle).onChange((text: string) => { this.replacement = text; })
          .onFocus(() => { this.nativeHints.focus('file-replace'); }).onBlur(() => { this.nativeHints.blur('file-replace'); })
            this.action(() => 'Replace all', () => { if (this.query) this.update(this.workspace.fileText.split(this.query).join(this.replacement)); })
          }
        }
      }
      Column() {
      if (this.comparing) {
        Scroll() { Column({ space: 8 }) {
        Text('On open').fontSize(12).fontColor(this.colors.muted).width('100%')
        this.source(() => this.workspace.activeFile?.text || '', false)
        Text('Your changes').fontSize(12).fontColor(this.colors.muted).width('100%')
        this.source(() => this.workspace.fileText, false)
        }.width('100%') }.height('100%').width('100%')
      } else if (this.editing && !this.normal) {
        TextArea({ text: this.workspace.fileText, controller: this.controller }).maxLength(2147483647).id('file-editor').fontSize(13).fontFamily('monospace')
          .onFocus(() => { this.nativeHints.focus('file-editor'); }).onBlur(() => { this.nativeHints.blur('file-editor'); })
          .enabled(!!this.workspace.activeFile?.editable)
          .fontColor(this.colors.text).backgroundColor(this.colors.code).height(this.bodyHeight).borderRadius(this.colors.radius)
          .onTextSelectionChange((start: number, end: number) => { this.cursor = end; })
          .onBlur(() => { this.metaDown = false; this.nativeHints.blur('file-editor'); }).onKeyPreIme((event: KeyEvent): boolean => this.keyboard(event))
          .onChange((text: string, preview: PreviewText) => { this.composing = !!preview.value; this.update(text, true, true); })
      } else if (!this.editing && this.preview && this.workspace.activeFile?.kind === 'markdown') {
        Scroll(this.previewScroller) {
          MarkdownView({ hintScope: 'panel', hintClip: this.hintClip, text: this.workspace.fileText, basePath: this.workspace.activeFile.rel, colors: this.colors, api: this.workspace.api, sessionId: this.workspace.selected?.session_id || '', onLink: (url: string) => { if (/^#L?\d+(?:[-:].*)?$/i.test(url)) { this.location = url; this.navigate(); } else if (url.startsWith('#')) this.anchor(url); else this.onLink(url); }, onCopy: this.onCopy, onHeading: (id: string, y: number) => { this.headings.set(id, y); } })
        }.onDidScroll(() => { if (this.alive && !this.restoring) this.savedView.previewY = this.previewScroller.currentOffset().yOffset; }).height(this.bodyHeight).width('100%').align(Alignment.TopStart)
      } else { this.source(() => this.workspace.fileText) }
      }.width('100%').layoutWeight(1).onAreaChange((_old: Area, area: Area) => { this.hintClip = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y), width: Number(area.width), height: Number(area.height) }; this.bodyHeight = Math.max(60, Number(area.height)); })
    }.width('100%').height(this.contentHeight)
  }
}
