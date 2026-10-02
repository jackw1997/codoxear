import { ThemeDropdown } from './ui/ThemeDropdown';
import { Workspace } from '../model/Workspace';
import { Palette } from '../model/Theme';
import { Session, sessionName } from '../model/Contracts';
import { ComposerChoice, composerChoices, supports } from '../model/ComposerCommands';
import { SessionDiagnostics, DetailRow, sessionDiagnostics, sessionOverview, contextDetails, technicalDetails } from '../model/SessionDetails';
import { HintTarget } from './HintTarget';
import { KeyboardHints } from '../model/KeyboardHints';

@Component
export struct SessionDetails {
  @ObjectLink workspace: Workspace;
  @Prop colors: Palette;
  @Consume nativeHints: KeyboardHints;
  onCopy: () => void = () => {};
  @State expanded: boolean = false;
  @State editing: string = '';
  @State value: string = '';
  @State error: string = '';
  @State accepted: string = '';

  private data(): SessionDiagnostics { return sessionDiagnostics(this.workspace.details) || this.workspace.selected || { session_id: '' }; }
  private session(): Session { return this.workspace.selected || this.data(); }
  private choices(): ComposerChoice[] { return composerChoices(this.session(), this.workspace.launchDefaults, '/' + this.editing + ' '); }
  private editable(kind: string): boolean { return supports(this.session(), kind) && !this.session().lost; }
  private begin(kind: string): void {
    this.editing = kind; this.error = ''; this.accepted = '';
    this.value = (kind === 'model' ? this.data().model : this.data().reasoning_effort) || '';
  }
  private async apply(): Promise<void> {
    if (this.workspace.settingBusy) return;
    this.error = '';
    const id = this.session().session_id;
    const kind = this.editing;
    const value = this.value.trim();
    try {
      await this.workspace.changeSessionSetting(kind, value);
      if (this.workspace.selected?.session_id !== id || !this.workspace.authenticated) return;
      this.accepted = (kind === 'model' ? 'Model: ' : 'Reasoning effort: ') + value +
        (this.session().agent_backend === 'codex' ? ' · accepted for the next turn' : ' · command sent');
      this.editing = '';
    } catch (reason) { this.error = (reason as Error).message || 'Unable to change the setting.'; }
  }
  @Builder
  action(label: string | (() => string), invoke: () => void, primary: boolean = false, enabled: () => boolean = () => true) {
    HintTarget({ label: typeof label === 'string' ? label : label(), button: true, scope: 'panel', activate: invoke, available: enabled() }) {
      Button(typeof label === 'string' ? label : label(), { type: ButtonType.Normal }).height(40).responseRegion({ x: 0, y: -2, width: '100%', height: 44 })
        .fontSize(13).fontWeight(FontWeight.Normal).padding({ left: 12, right: 12 }).borderRadius(this.colors.radius)
        .fontColor(primary ? this.colors.onPrimary : this.colors.text).backgroundColor(primary ? this.colors.primary : this.colors.paper)
        .border({ width: 1, color: primary ? this.colors.primary : this.colors.hairline }).enabled(enabled()).opacity(enabled() ? 1 : 0.5)
        .id(typeof label === 'string' ? label : label()).onClick(invoke)
    }
  }
  @Builder
  heading(title: string) {
    Text(title).fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.colors.text).width('100%')
  }
  @Builder
  rows(values: DetailRow[]) {
    Column() {
      ForEach(values, (item: DetailRow) => {
        Column({ space: 4 }) {
          Text(item.label).fontSize(12).fontColor(this.colors.muted).width('100%')
          Text(item.value).fontSize(14).fontColor(this.colors.text).copyOption(CopyOptions.LocalDevice).width('100%')
        }.padding({ top: 10, bottom: 10 }).width('100%').border({ width: { bottom: 1 }, color: this.colors.hairline })
      }, (item: DetailRow) => item.label)
    }.width('100%')
  }
  @Builder
  setting(label: string, kind: string, current: string) {
    Row({ space: 12 }) {
      Column({ space: 5 }) {
        Text(label).fontSize(12).fontColor(this.colors.muted).width('100%')
        Text(current || 'Not reported').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.colors.text).width('100%')
      }.layoutWeight(1)
      this.action('Change ' + label.toLowerCase(), () => { this.begin(kind); }, false, () => !this.workspace.settingBusy && this.editable(kind))
    }.width('100%').padding({ top: 10, bottom: 10 })
  }
  build() {
    Column({ space: 20 }) {
      Column({ space: 4 }) {
        Text(sessionName(this.session())).fontSize(18).fontWeight(FontWeight.Medium).fontColor(this.colors.text).width('100%')
        this.setting('Model', 'model', this.data().model || '')
        this.setting('Reasoning effort', 'effort', this.data().reasoning_effort || '')
        if (!this.editable('model') || !this.editable('effort')) {
          Text('Unavailable changes are disabled because this session does not expose the corresponding live control.').fontSize(12).fontColor(this.colors.muted).width('100%')
        }
        if (this.editing) {
          Column({ space: 12 }) {
            this.heading(this.editing === 'model' ? 'Change model' : 'Change reasoning effort')
            if (this.choices().length) {
              ThemeDropdown({ colors: this.colors, options: this.choices().map((choice: ComposerChoice): string => choice.value), controlId: 'details-setting-choice', label: this.editing === 'model' ? 'Model' : 'Reasoning effort', value: this.value,
                onSelect: (_index: number, value: string) => { this.value = value; } })
            }
            if (this.editing === 'model') {
              TextInput({ text: this.value, placeholder: 'Model name' }).id('details-model-input').height(44)
                .fontSize(14).fontColor(this.colors.text).placeholderColor(this.colors.muted).backgroundColor(this.colors.paper)
                .border({ width: 1, color: this.colors.hairline }).borderRadius(this.colors.radius)
                .onChange((value: string) => { this.value = value; })
                .onFocus(() => { this.nativeHints.focus('details-model-input'); }).onBlur(() => { this.nativeHints.blur('details-model-input'); })
            }
            Text(this.session().agent_backend === 'codex' ? 'Applies to the next turn. Your current draft stays unchanged.' : 'Sends a settings command to this session. Your current draft stays unchanged.').fontSize(12).fontColor(this.colors.muted).width('100%')
            Row({ space: 8 }) {
              this.action(() => this.workspace.settingBusy ? 'Applying…' : 'Apply change', () => { this.apply(); }, true, () => !this.workspace.settingBusy && !!this.value.trim())
              this.action('Cancel change', () => { this.editing = ''; this.error = ''; }, false, () => !this.workspace.settingBusy)
            }.width('100%')
          }.width('100%').padding(12).backgroundColor(this.colors.subtle).borderRadius(this.colors.radius)
        }
        if (this.error) { Text(this.error).fontSize(13).fontColor(this.colors.danger).width('100%') }
        if (this.accepted) { Text(this.accepted).fontSize(13).fontColor(this.colors.text).width('100%') }
      }.width('100%')
      Column({ space: 6 }) { this.heading('Session'); this.rows(sessionOverview(this.data())) }.width('100%')
      Column({ space: 6 }) {
        this.heading('Context usage')
        if (contextDetails(this.data().token).length) { this.rows(contextDetails(this.data().token)) }
        else { Text('No context usage reported yet.').fontSize(13).fontColor(this.colors.muted).width('100%') }
      }.width('100%')
      this.action('Copy conversation', this.onCopy)
      Column({ space: 6 }) {
        this.action(() => this.expanded ? 'Hide technical details' : 'Show technical details', () => { this.expanded = !this.expanded; })
        if (this.expanded) { this.rows(technicalDetails(this.data())) }
      }.width('100%').alignItems(HorizontalAlign.Start)
    }.width('100%').alignItems(HorizontalAlign.Start)
  }
}
