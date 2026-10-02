"""Escape preserves native dialogs and confirmation choices, including focused inputs."""
import time
import native_ui as u
def esc():u.run('shell','uitest','uiInput','keyEvent','2070');time.sleep(.5)
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
u.click('New session');u.type_at('Working directory','/tmp/native-unsaved-dialog',True);esc()
u.node('Working directory');assert any(n.get('text')=='/tmp/native-unsaved-dialog' for n in u.layout())
u.click('Close');u.click('Sessions');u.select_session('Native verified session');u.click('Files')
u.type_at('Search files','native-history-edit',True);esc();u.node('Search files')
u.click('Search');u.click('native-history-edit.txt');u.click('Edit')
original=u.node('file-editor').get('text');u.type_at('file-editor','Native unsaved modal policy',True)
u.click('file-editor');esc();u.node('NORMAL');assert any(n.get('text','').strip()=='Native unsaved modal policy' for n in u.layout())
u.click('Close');u.node('Discard unsaved changes?');esc();u.node('Discard unsaved changes?')
u.click('Keep editing');assert any(n.get('text','').strip()=='Native unsaved modal policy' for n in u.layout())
u.click('Close');u.click('Discard');u.node('message-input')
u.capture('../../../artifacts/harmonyos/native-modal-policy.png')
print('PASS Escape retains new-session form, file search, unsaved editor and discard confirmation; explicit Keep editing/Discard work')
