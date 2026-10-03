"""Real OS vault + login lifecycle on the owned emulator, Docker proxy 19754.
No model calls, prompts, or production services are used.
"""
import os, sys, time, subprocess
from pathlib import Path
import native_ui as u
assert os.environ.get('CODOXEAR_HDC_TARGET') == '127.0.0.1:15558'
evidence = Path(sys.argv[1]).resolve(); evidence.mkdir(parents=True, exist_ok=True)
endpoint = 'http://127.0.0.1:19754'
password = 'native-test-password'
def fault(name, enabled):
    subprocess.run(['docker','--context','colima-codoxear-test','exec','codoxear-login-proxy',
                    'touch' if enabled else 'rm','/tmp/'+name], check=True, capture_output=True)
def wait(label): return u.node(label)
def texts(): return {n.get('text') for n in u.layout()}
def restart():
    u.run('shell','aa','force-stop','com.codoxear.mobile')
    u.run('shell','aa','start','-a','EntryAbility','-b','com.codoxear.mobile'); time.sleep(2)
def enter(remember=True):
    u.type_at('Server address', endpoint, True); u.type_at('password',password,True)
    checked=u.node('remember-password').get('checked') == 'true'
    if checked != remember: u.click('remember-password')
    u.click('Login'); wait('Log out')
    assert not any('could not be saved' in (n.get('text') or '') for n in u.layout()), 'OS vault save failed'
def logout():
    if 'Log out' not in texts(): u.click('Sessions')
    u.click('Log out'); wait('Codoxear login')

restart()
if 'Codoxear login' not in texts(): logout()
enter()
u.capture(evidence/'saved-login.png')
restart(); wait('Log out'); assert 'Codoxear login' not in texts()
u.capture(evidence/'automatic-restart.png')
# App update with original identity must preserve OS vault credentials.
u.run('install','-r',str(Path(__file__).resolve().parents[1]/'entry/build/default/outputs/default/entry-default-unsigned.hap'))
restart(); wait('Log out')
print('PASS actual OS vault, force-stop restart and same-identity app update',flush=True)
# A temporary server failure must retain credentials, with a manual retry.
fault('network-unavailable',True)
try:
    restart(); wait('temporary fixture outage')
    assert u.node('password').get('text'), 'Retry lost the remembered password'
    u.capture(evidence/'offline-retry.png')
finally: fault('network-unavailable',False)
u.click('Login'); wait('Log out')
print('PASS offline auto-login failure and retry without retyping',flush=True)
# Explicit offline logout still removes the local secret.
fault('network-unavailable',True)
try: logout()
finally: fault('network-unavailable',False)
restart(); wait('Codoxear login'); assert not u.node('password').get('text')
print('PASS offline logout removes saved password',flush=True)
# Opt out, authenticate, restart: no automatic login.
enter(False); restart(); wait('Codoxear login'); assert not u.node('password').get('text')
print('PASS remember-password opt-out',flush=True)
# Invalidated saved credentials are cleared rather than retried each restart.
for fault_name, error in [('reject-auth', 'authentication expired'), ('reject-password', 'bad password')]:
    enter(True); fault(fault_name,True)
    try:
        restart(); wait(error); assert not u.node('password').get('text')
    finally: fault(fault_name,False)
    restart(); wait('Codoxear login'); assert not u.node('password').get('text')
u.capture(evidence/'expired-login.png')
print('PASS rejected credentials cleared, no automatic retry loop',flush=True)
# Leave the shared test environment at its original endpoint, without saving.
u.type_at('Server address','http://127.0.0.1:19744',True)
u.type_at('password',password,True)
if u.node('remember-password').get('checked') == 'true': u.click('remember-password')
u.click('Login'); wait('Log out')
print('PASS restored emulator to protected preview, no credentials retained',flush=True)
