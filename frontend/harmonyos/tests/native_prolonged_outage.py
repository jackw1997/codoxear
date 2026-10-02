"""Two-minute native outage: visible retry state, editing and explicit recovery.
Uses only the dedicated19746 Docker proxy and15557 development emulator.
"""
import runpy, subprocess, time
import native_ui as u

call = runpy.run_path('/tmp/codoxear-cli-common.py')['call']
sid = 'native-send-boundary'
marker = f'NATIVE_LONG_OUTAGE_{time.time_ns()}'
draft = marker + '\n中文离线草稿\nThird line'
def fault(enabled):
    subprocess.run(['docker', '--context', 'colima-codoxear-test', 'exec', 'codoxear-native-boundary-proxy', 'python', '-c', "from pathlib import Path;p=Path('/tmp/network-unavailable');" + ('p.touch()' if enabled else 'p.unlink(missing_ok=True)')], check=True)
def count():
    return sum(e.get('role') == 'user' and marker in e.get('text', '') for e in call(f'/api/sessions/{sid}/messages/tail?limit=100')['events'])
def status(): u.node('Reconnecting… Your draft is kept on this device.')

u.run('shell', 'aa', 'force-stop', 'com.codoxear.mobile')
u.login('http://127.0.0.1:19746'); u.select_session('Send boundary verification'); u.type_at('message-input', draft, True)
try:
    fault(True); started = time.monotonic()
    u.click('Send'); u.node('temporary fixture outage'); status()
    assert u.node('message-input')['text'] == draft and count() == 0
    draft += '\nStill editable after rejection 😀'
    u.type_at('message-input', draft, True)
    u.run('shell', 'uitest', 'uiInput', 'keyEvent', 'Home'); time.sleep(3)
    u.run('shell', 'aa', 'start', '-a', 'EntryAbility', '-b', 'com.codoxear.mobile')
    status(); assert u.node('message-input')['text'] == draft
    print('PASS prolonged outage shows reconnect status; rejected send remains editable and survives background/return', flush=True)
    for milestone in (60, 120):
        while time.monotonic() - started < milestone: time.sleep(1)
        status(); assert u.node('message-input')['text'] == draft and count() == 0
        print(f'PASS {milestone}s outage retains draft and no automatic send', flush=True)
    u.capture('../../../artifacts/harmonyos/native-prolonged-outage.png')
finally: fault(False)

deadline = time.monotonic() + 20
while time.monotonic() < deadline:
    if not any(n.get('text') == 'Reconnecting… Your draft is kept on this device.' for n in u.layout()): break
    time.sleep(.5)
else: raise AssertionError('Reconnect status did not clear after network recovery')
assert u.node('message-input')['text'] == draft and count() == 0
u.click('Send')
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    if count() == 1 and u.node('message-input').get('text', '') == '': break
    time.sleep(.5)
else: raise AssertionError('Explicit retry did not commit once/clear draft')
u.capture('../../../artifacts/harmonyos/native-prolonged-outage-recovered.png')
print('PASS automatic reconnect preserves unsent draft; explicit retry commits once and clears composer', flush=True)
