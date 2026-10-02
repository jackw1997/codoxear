"""Git search from a nested cwd and an explicit outside-cwd reference."""
import json,time,re,subprocess
import native_ui as u
record=json.load(open('/tmp/codoxear-native-path-scope.json'))
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Nested path verification')
u.click('Files');u.type_at('Search files','native-nested-token.py',True);u.click('Search');u.click(record['entry']['path']);u.click('Edit')
original=u.node('file-editor').get('text');assert original.startswith('raw_byte_path_line_1 = 1\n')
changed=original+'# saved from nested cwd 中文\n';u.type_at('file-editor',changed,True);u.click('Save');u.node('Saved')
actual=subprocess.check_output(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','python3','-c',"import sys;sys.stdout.buffer.write(open(b'/home/tester/native-parity-fixture/native-nested-cwd/native-path-\\xff/native-nested-token.py','rb').read())"])
assert actual.decode()==changed
u.click('Reload');assert u.node('file-editor').get('text')==changed
u.type_at('file-editor',original,True);u.click('Save');u.node('Saved');u.click('Close')
u.type_at('message-input','Open [Outside working directory](/home/tester/.codex/memories/native-citation-verification.md#L40)',True);u.click('Send');time.sleep(2)
if any(n.get('id')=='Latest messages' for n in u.layout()):u.click('Latest messages')
n=next(n for n in u.layout() if n.get('text','').startswith('Open Outside working directory'));x,y,r,b=map(int,re.findall(r'\d+',n['bounds']));u.run('shell','uitest','uiInput','click',str(x+240),str((y+b)//2));time.sleep(.5)
u.node('Native memory reference line 40');u.capture('../../../artifacts/harmonyos/native-outside-cwd-reference.png')
print('PASS native Git search resolves relative to nested session cwd; raw-byte edit/save/reload matches server; explicit outside-cwd reference opens at line 40')
