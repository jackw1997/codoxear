"""Crash recovery keeps a native file buffer and its original server version."""
import time, subprocess
import native_ui as u

def fixture(text):
    subprocess.run(['docker','--context','colima-codoxear-test','exec','-i','codoxear-harmony-test','python3','-c',"from pathlib import Path; import sys; Path('/home/tester/native-parity-fixture/native-history-edit.txt').write_text(sys.stdin.read())"],input=text,text=True,check=True)
def open_file():
    u.select_session('Native verified session');u.click('Files');u.type_at('Search files','native-history-edit',True);u.click('Search');u.click('native-history-edit.txt')
def texts(): return '\n'.join(n.get('text','') for n in u.layout() if n.get('text'))

draft='Unsaved recovery check\nUnicode 中文 😀\nThird line'
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');open_file();u.click('Edit');u.type_at('file-editor',draft,True)
u.run('shell','aa','force-stop','com.codoxear.mobile')
fixture('Remote changed while app was closed\n')
u.login('http://127.0.0.1:19744');u.select_session('Native verified session');u.click('Files');u.click('Recover unsaved files');u.click('native-history-edit.txt');u.click('Edit')
assert u.node('file-editor').get('text')==draft,texts()
u.click('Save');time.sleep(.4)
assert u.node('file-editor').get('text')==draft
assert any(word in texts().lower() for word in ('conflict','changed','version')),texts()
u.capture('../../../artifacts/harmonyos/native-file-recovered-conflict.png')
u.click('Reload');u.click('Keep editing');assert u.node('file-editor').get('text')==draft
u.click('Reload');dialog=next(n for n in u.layout() if n.get('text')=='Reload' and n.get('type')=='Text');u.run('shell','uitest','uiInput','click',*u.center(dialog));time.sleep(.6)
assert u.node('file-editor').get('text')=='Remote changed while app was closed\n'
u.click('Undo');assert u.node('file-editor').get('text')=='Remote changed while app was closed\n'
u.type_at('file-editor','original\nsecond line\n',True);u.click('Save')
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');open_file();u.click('Edit')
assert u.node('file-editor').get('text')=='original\nsecond line\n'
assert 'Unsaved' not in texts()
u.click('Browse');u.click('Recover unsaved files');assert 'No unsaved files' in texts(),texts()
print('PASS: native Unicode file draft survives force-stop, original conflict token retained, reload cancel/confirm, reset undo and cleared recovery after save')
