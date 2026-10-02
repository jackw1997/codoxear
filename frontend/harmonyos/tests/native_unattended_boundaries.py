"""Actual native configuration failure/retry and server cooldown/budget boundaries.

Requires the dedicated Docker synthetic broker native-unattended-boundary and
fault proxy19746. Never inject faults into the user's preview proxy19744.
"""
import json, runpy, subprocess, time
from datetime import datetime
import native_ui as u

call = runpy.run_path('/tmp/codoxear-cli-common.py')['call']
sid = 'native-unattended-boundary'
proxy = 'codoxear-native-boundary-proxy'
marker = f'Native unattended boundary {time.time_ns()}'

def docker(code):
    return subprocess.check_output(['docker', '--context', 'colima-codoxear-test', 'exec', '-u', 'tester', 'codoxear-harmony-test', 'python', '-c', code], text=True)

def flag(name, enabled):
    path = f'/home/tester/{sid}.{name}'
    docker(f'from pathlib import Path;p=Path({path!r});' + ('p.touch()' if enabled else 'p.unlink(missing_ok=True)'))

def outage(enabled):
    subprocess.run(['docker', '--context', 'colima-codoxear-test', 'exec', proxy, 'python', '-c', "from pathlib import Path;p=Path('/tmp/network-unavailable');" + ('p.touch()' if enabled else 'p.unlink(missing_ok=True)')], check=True)

def config(): return call(f'/api/sessions/{sid}/unattended')
def commits(): return [e for e in call(f'/api/sessions/{sid}/messages/tail?limit=100')['events'] if e.get('role') == 'user' and marker in e.get('text', '')]
def rejected():
    return json.loads(docker(f"import json;from pathlib import Path;p=Path('/home/tester/{sid}.rejected.jsonl');print(json.dumps([json.loads(s) for s in p.read_text().splitlines() if {marker!r} in s] if p.exists() else []))"))
def wait(check, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check(): return
        time.sleep(1)
    raise AssertionError('Timed out waiting for unattended state')
def input_value(label):
    return next(n.get('text', '') for n in u.layout() if n.get('type') in ('TextInput', 'TextArea') and (n.get('id') == label or n.get('hint') == label))

before = config()
assert not before['enabled'], 'Dedicated unattended fixture must start disabled'
flag('reject-all-sends', True)
try:
    u.run('rport', 'tcp:19746', 'tcp:19746')
    u.run('shell', 'aa', 'force-stop', 'com.codoxear.mobile')
    u.login('http://127.0.0.1:19746'); u.select_session('Unattended boundary verification'); u.click('Unattended')
    switch = next(n for n in u.layout() if n.get('type') == 'Toggle')
    assert switch.get('checked') == 'false', switch
    u.run('shell', 'uitest', 'uiInput', 'click', *u.center(switch))
    u.type_at('unattended-request', marker, True)
    u.type_at('Cooldown (minutes)', '1', True); u.type_at('Remaining injections', '2', True)
    outage(True); u.click('Save'); u.node('temporary fixture outage')
    assert input_value('unattended-request') == marker
    assert input_value('Cooldown (minutes)') == '1' and input_value('Remaining injections') == '2'
    assert config() == before, 'Rejected save changed server state'
    u.capture('../../../artifacts/harmonyos/native-unattended-save-rejected.png')
    outage(False); u.click('Save'); u.node('message-input')
    assert config()['enabled'] and config()['remaining_injections'] == 2
    wait(lambda: len(rejected()) >= 2, 85)
    assert config()['remaining_injections'] == 2 and not commits()
    print('PASS rejected Save preserves all fields/server state; explicit retry saves; failed automatic injections consume no budget', flush=True)
    flag('reject-all-sends', False)
    wait(lambda: len(commits()) == 1 and config()['remaining_injections'] == 1, 20)
    first_observed = time.monotonic()
    u.click('Unattended')
    assert input_value('Remaining injections') == '1'
    u.capture('../../../artifacts/harmonyos/native-unattended-one-remaining.png'); u.click('Close')
    while time.monotonic() - first_observed < 45:
        assert len(commits()) == 1 and config()['remaining_injections'] == 1
        time.sleep(1)
    print('PASS cooldown blocks a second injection through first 45 seconds', flush=True)
    wait(lambda: len(commits()) == 2 and config()['remaining_injections'] == 0, 40)
    rows = commits()
    # Read exact broker transcript timestamps independently of poll observation.
    stamps = json.loads(docker(f"import json;from pathlib import Path;print(json.dumps([r['timestamp'] for r in map(json.loads,Path('/home/tester/{sid}.jsonl').read_text().splitlines()) if r.get('type')=='event_msg' and r.get('payload',{{}}).get('type')=='user_message' and {marker!r} in r['payload'].get('message','')]))"))
    interval = (datetime.fromisoformat(stamps[1].replace('Z', '+00:00')) - datetime.fromisoformat(stamps[0].replace('Z', '+00:00'))).total_seconds()
    assert interval >= 60, interval
    assert not config()['enabled']
    u.click('Unattended')
    assert input_value('Remaining injections') == '0'
    assert next(n for n in u.layout() if n.get('type') == 'Toggle').get('checked') == 'false'
    u.capture('../../../artifacts/harmonyos/native-unattended-exhausted.png'); u.click('Close')
    print(f'PASS two successful injections {interval:.2f}s apart; budget exhausted and native reopened form shows disabled/zero', flush=True)
finally:
    outage(False); flag('reject-all-sends', False)
    current = config(); current['enabled'] = False
    call(f'/api/sessions/{sid}/unattended', current)
