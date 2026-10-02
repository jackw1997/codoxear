"""Real native session details, backed by a Docker-only settings broker fixture.

Start fixture_backend.py native-details with CODOXEAR_FIXTURE_SETTINGS=1 first.
Run against a dedicated emulator via CODOXEAR_HDC_TARGET; never a user's device.
"""
import json, subprocess, time
import native_ui as u

sid='native-details'
def docker(*args):
    return subprocess.check_output(['docker','--context','colima-codoxear-test','exec','-u','tester','codoxear-harmony-test',*args],text=True)
def requests():
    output=docker('python3','-c',"from pathlib import Path;p=Path('/home/tester/native-details.settings.jsonl');print(p.read_text() if p.exists() else '')")
    return [json.loads(line) for line in output.splitlines() if line]
def scroll_to(label):
    for _ in range(8):
        hits=[n for n in u.layout() if n.get('text')==label]
        if hits and int(u.center(hits[0])[1]) < 2735:return
        u.run('shell','uitest','uiInput','swipe','1100','2400','1100','1100','450');time.sleep(.3)
    raise AssertionError('Not visible: '+label)

initial=len(requests())
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
u.click('session-meta-native-details');u.type_at('message-input','Details draft preserved',True)
u.click('Session details');u.node('Model');u.node('Reasoning effort')
assert not any(n.get('text')=='Session ID' for n in u.layout())
u.capture('../../../artifacts/harmonyos/details-top.png')
u.click('Change model');u.type_at('details-model-input','fixture-next-model',True);u.click('Cancel change')
assert len(requests())==initial
u.click('Change reasoning effort');u.click('details-setting-choice');u.click('high')
assert u.node('Apply change')['enabled']=='true', 'Selecting effort must enable Apply'
u.click('Apply change');u.node('Reasoning effort: high · accepted for the next turn')
u.click('Change model');u.type_at('details-model-input','fixture-next-model',True);u.click('Apply change')
u.node('Model: fixture-next-model · accepted for the next turn')
assert requests()[initial:]==[{'cmd':'settings','effort':'high'},{'cmd':'settings','model':'fixture-next-model'}]
u.capture('../../../artifacts/harmonyos/details-change.png')
u.click('Close');assert u.node('message-input')['text']=='Details draft preserved'
u.click('Session details');scroll_to('Show technical details');u.click('Show technical details');scroll_to('Session ID');u.node('Session ID')
u.capture('../../../artifacts/harmonyos/details-expanded.png')
u.click('Hide technical details');assert not any(n.get('text')=='Session ID' for n in u.layout())
u.click('Close');u.click('Session details')
docker('touch','/home/tester/native-details.reject-settings')
try:
    u.click('Change model');u.type_at('details-model-input','fixture-rejected-model',True);u.click('Apply change')
    u.node('Synthetic setting rejected');assert u.node('Apply change')['enabled']=='true'
    assert not any(n.get('text')=='Model: fixture-rejected-model · accepted for the next turn' for n in u.layout())
    u.capture('../../../artifacts/harmonyos/details-error.png')
finally:docker('rm','-f','/home/tester/native-details.reject-settings')
u.click('Close');assert u.node('message-input')['text']=='Details draft preserved'
u.type_at('message-input','',True)
print('PASS native details: grouped fields, collapsed/expanded technical info, cancel sends nothing, model/effort accepted, server rejection visible, composer draft preserved')
