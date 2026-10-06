import { NativeApp } from '../model/NativeApp';
import { HubAccount, NativeComputer } from '../services/HubAccounts';
import { Session, ChatEvent } from '../model/Contracts';
import { palette, Palette } from '../model/Theme';

@Entry
@Component
struct Index {
  @State revision: number = 0;
  @State hubOrigin: string = '';
  @State directOrigin: string = '';
  @State password: string = '';
  @State savePassword: boolean = false;
  @State showDirect: boolean = false;
  @State family: string = 'clay';
  @State dark: boolean = false;
  @State app: NativeApp = AppStorage.get<NativeApp>('codoxearNativeApp')!;
  private colors(): Palette { return palette(this.family, this.dark); }
  aboutToAppear(): void { this.app.onChanged = () => { this.revision++; }; }
  aboutToDisappear(): void { this.app.onChanged = () => {}; }
  private perform(operation: () => Promise<void>): void {
    void operation().catch(error => { this.app.error = error.message; }).finally(() => { this.revision++; });
  }
  @Builder
  accounts() {
    Column({ space: 12 }) {
      Text('Hubs & computers').fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.colors().text)
      TextInput({ text: this.hubOrigin, placeholder: 'https://your-hub.example' }).height(48).onChange(value => { this.hubOrigin = value; })
      Button('Sign in with this Hub').height(48).onClick(() => this.perform(() => this.app.accounts.begin(this.hubOrigin)))
      if (this.app.accounts.pending) {
        Text('Complete sign-in in your system browser.').fontColor(this.colors().text)
        Button('Cancel sign-in').height(48).onClick(() => this.perform(() => this.app.accounts.cancel()))
      }
      ForEach(this.app.accounts.accounts, (account: HubAccount) => {
        Column({ space: 4 }) {
          Button(account.name + ' · ' + account.origin).height(48).onClick(() => this.perform(() => this.app.chooseAccount(account.key)))
          Button('Remove ' + account.name + ' from this device').height(48).onClick(() => this.perform(() => this.app.accounts.logout(account.key)))
        }
      }, (account: HubAccount) => account.key)
      ForEach(this.app.computers, (computer: NativeComputer) => {
        Row({ space: 8 }) {
          Button(computer.name).height(48).onClick(() => this.perform(() => this.app.chooseComputer(computer)))
          Button('Enable notifications').height(48).onClick(() => this.perform(() => this.app.push.enable(this.app.accounts.selected, computer)))
        }
      }, (computer: NativeComputer) => computer.id)
      ForEach(this.app.push.registrations, row => {
        Button('Disable notifications · ' + row.computerId).height(48).onClick(() => this.perform(() => this.app.push.disable(row.key)))
      }, row => row.key)
      Button(this.showDirect ? 'Hide direct server login' : 'Direct server login').height(48).onClick(() => { this.showDirect = !this.showDirect; })
      if (this.showDirect) {
        TextInput({ text: this.directOrigin, placeholder: 'Direct server address' }).height(48).onChange(value => {
          this.directOrigin = value;
          void this.app.direct.password(value).then(saved => { if (this.directOrigin === value) this.password = saved; });
        })
        TextInput({ text: this.password, placeholder: 'Password' }).type(InputType.Password).height(48).onChange(value => { this.password = value; })
        Row({ space: 8 }) { Checkbox({ name: 'savePassword' }).select(this.savePassword).onChange(value => { this.savePassword = value; }); Text('Save password on this device').fontColor(this.colors().text) }.height(48)
        Button('Connect directly').height(48).onClick(() => this.perform(() => this.app.connectDirect(this.directOrigin, this.password, this.savePassword)))
        Button('Remove saved direct password').height(48).onClick(() => this.perform(() => this.app.direct.clear()))
      }
      Row({ space: 8 }) {
        ForEach(['clay', 'paper', 'slate'], (name: string) => { Button(name).height(44).onClick(() => { this.family = name; }) })
        Button(this.dark ? 'Light' : 'Dark').height(44).onClick(() => { this.dark = !this.dark; })
      }
      Button('Back to conversation').height(48).onClick(() => { this.app.panel = false; this.revision++; })
    }.padding(16).backgroundColor(this.colors().panel)
  }
  build() {
    Column() {
      Row() {
        Text('Codoxear').fontSize(20).fontWeight(FontWeight.Bold).layoutWeight(1).fontColor(this.colors().text)
        Button('Agents').height(44).onClick(() => { this.app.workspace.sidebar = !this.app.workspace.sidebar; this.revision++; })
        Button('Hubs & computers').height(44).onClick(() => { this.app.panel = !this.app.panel; this.revision++; })
      }.padding(12)
      if (this.app.error || this.app.workspace.error) { Text(this.app.error || this.app.workspace.error).fontColor(this.colors().danger).padding(12) }
      if (this.app.panel || !this.app.workspace.authenticated) {
        Scroll() { this.accounts() }.layoutWeight(1)
      } else {
        if (this.app.workspace.sidebar) {
          Scroll() {
            Column({ space: 4 }) {
              ForEach(this.app.workspace.sessions, (session: Session) => {
                Button(session.name || session.session_id).height(48).width('100%').onClick(() => this.perform(() => this.app.workspace.select(session)))
              }, (session: Session) => session.session_id)
            }.padding(12)
          }.height('30%').backgroundColor(this.colors().panel)
        }
        Text(this.app.workspace.selected?.name || 'Choose an agent').padding(12).fontWeight(FontWeight.Bold).fontColor(this.colors().text)
        Scroll() {
          Column({ space: 12 }) {
            ForEach(this.app.workspace.events, (event: ChatEvent) => {
              Column({ space: 4 }) { Text(event.role).fontSize(12).fontColor(this.colors().muted); Text(event.text).width('100%').fontColor(this.colors().text).copyOption(CopyOptions.LocalDevice) }
                .padding(12).backgroundColor(event.role === 'user' ? this.colors().userBubble : this.colors().assistantBubble).borderRadius(this.colors().bubbleRadius)
            }, (event: ChatEvent) => event.event_id || event.message_id || event.role + ':' + event.ts)
          }.padding(12)
        }.layoutWeight(1)
        TextArea({ text: this.app.workspace.draft, placeholder: 'Message' }).height(100).onChange(value => { this.app.workspace.draft = value; })
        Button('Send').height(48).width('100%').enabled(!!this.app.workspace.selected && !this.app.workspace.sending).onClick(() => this.perform(() => this.app.workspace.send()))
      }
    }.width('100%').height('100%').backgroundColor(this.colors().background).id('native-workspace-' + this.revision)
  }
}
