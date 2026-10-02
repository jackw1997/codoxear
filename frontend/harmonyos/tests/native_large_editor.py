"""1.2 MB editable file: real native source, caret edits, undo and crash recovery."""
import time,hashlib,subprocess,argparse
import native_ui as u

def key(*codes):
    u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def editor():
    for _ in range(30):
        fields=[n for n in u.layout() if n.get('id')=='file-editor']
        if fields:return fields[0]['text']
        time.sleep(.5)
    raise AssertionError('Editor did not appear')
def texts():return '\n'.join(n.get('text','') for n in u.layout() if n.get('text'))
arguments=argparse.ArgumentParser();arguments.add_argument('--upgrade-hap');arguments.add_argument('--typing-probe',action='store_true');options=arguments.parse_args()
base=subprocess.check_output(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','cat','/home/tester/native-parity-fixture/native-large-edit.txt']).decode()
assert len(base.encode())==1212000
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session');u.click('Files')
u.type_at('Search files','native-large-edit.txt',True);u.click('Search')
start=time.monotonic();u.click('native-large-edit.txt')
assert 'row_00000' in texts();print('Open + UI dump seconds',round(time.monotonic()-start,2),flush=True)
u.click('Edit');time.sleep(2);assert editor()==base;u.click('file-editor');key(2070);u.click('file-keyboard');key(2047,2023);key(2025)
if options.typing_probe:
    # Hardware events reach the actual TextArea one at a time. The elapsed time
    # includes hdc/uitest overhead; use a native profiler for UI-thread latency.
    start=time.monotonic()
    for _ in range(20):u.run('shell','uitest','uiInput','keyEvent','2017')
    typed=editor();assert typed.replace('a'*20,'',1)==base
    for _ in range(20):u.run('shell','uitest','uiInput','keyEvent','2055')
    for _ in range(20):
        if editor()==base:break
        time.sleep(.2)
    assert editor()==base
    print('PASS 20 single-key insertions and deletions; UI driver seconds',round(time.monotonic()-start,2),flush=True)
start=time.monotonic();assert editor()==base;time.sleep(1);u.run('shell','uitest','uiInput','text','LARGE_UNICODE_中文😀')
for _ in range(20):
    if 'LARGE_UNICODE_中文😀' in editor():break
    time.sleep(.5)
assert 'LARGE_UNICODE_中文😀' in editor()
key(2070);u.click('file-keyboard');key(2025)
changed=editor();print('Edit + mode switches + dump seconds',round(time.monotonic()-start,2),flush=True)
assert changed.replace('LARGE_UNICODE_中文😀','')==base and changed.index('LARGE_UNICODE_中文😀')>len(base)-200
u.run('shell','uitest','uiInput','keyEvent','Back');u.click('Undo');assert editor()==base
u.click('Redo');assert editor()==changed
u.run('shell','aa','force-stop','com.codoxear.mobile')
if options.upgrade_hap:
    u.run('install','-r',options.upgrade_hap);print('Installed upgrade with an existing unsaved large buffer',flush=True)
u.login('http://127.0.0.1:19744');u.select_session('Native verified session');u.click('Files');u.click('Recover unsaved files');u.click('native-large-edit.txt');u.click('Edit')
assert editor()==changed
u.run('shell','uitest','uiInput','keyEvent','Back');u.click('Save')
for _ in range(30):
    if u.node('file-keyboard')['text']=='Saved':break
    time.sleep(.5)
assert u.node('file-keyboard')['text']=='Saved'
received=subprocess.check_output(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','cat','/home/tester/native-parity-fixture/native-large-edit.txt'])
assert received==changed.encode()
print('PASS large saved SHA256',hashlib.sha256(received).hexdigest(),flush=True)
# Restore this disposable fixture through the editor, checking the save as well.
u.click('Find');u.type_at('file-find','LARGE_UNICODE_中文😀',True);u.click('Replace all');u.click('Save');time.sleep(1)
assert subprocess.check_output(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','cat','/home/tester/native-parity-fixture/native-large-edit.txt'])==base.encode()
print('PASS: 1.2 MB native file open/edit/undo/redo, exact Unicode recovery, server save and original fixture restored')
