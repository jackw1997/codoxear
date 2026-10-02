"""A prose reference preserves raw filename bytes through inspect/read/edit/save."""
import time,re
import native_ui as u
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.type_at('message-input','native-path-token.py:40',True);u.click('Send');time.sleep(3)
if any(n.get('id')=='Latest messages' for n in u.layout()):u.click('Latest messages')
n=u.node('native-path-token.py:40');x,y,r,b=map(int,re.findall(r'\d+',n['bounds']))
u.run('shell','uitest','uiInput','click',str(x+70),str((y+b)//2));time.sleep(1)
u.node('raw_byte_path_line_40 = 40')
assert not any(n.get('text')=='raw_byte_path_line_1 = 1' for n in u.layout())
u.capture('../../../artifacts/harmonyos/native-reference-raw-path.png')
u.click('Edit')
original=''.join(f'raw_byte_path_line_{n} = {n}\n' for n in range(1,81))
assert u.node('file-editor').get('text').startswith(original)
draft=original+'# raw-byte identity 中文 😀\n'
u.type_at('file-editor',draft,True)
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.click('Files');u.click('Recover unsaved files');recovered=next(n.get('text') for n in u.layout() if n.get('text','').endswith('/native-path-token.py'));u.click(recovered);u.click('Edit')
assert u.node('file-editor').get('text')==draft
u.click('Save');u.node('Saved')
import subprocess
actual=subprocess.check_output(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','python3','-c',"import sys;sys.stdout.buffer.write(open(b'/home/tester/native-parity-fixture/native-path-\\xff/native-path-token.py','rb').read())"])
assert actual.decode()==draft
u.click('Reload');assert u.node('file-editor').get('text')==draft
u.type_at('file-editor',original,True);u.click('Save');u.node('Saved')
print('PASS raw-byte path exact save/reload/draft recovery; prose file reference retains raw-byte path identity and opens native source at line 40')
