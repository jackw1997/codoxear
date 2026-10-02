"""Native catalog reconciliation after another client deletes a fixture session."""
import json,time,subprocess,urllib.request,http.cookiejar
import native_ui as u
sid='native-removal-'+str(time.time_ns());alias='Session removal verification'
api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def call(path,data=None):
 req=urllib.request.Request('http://127.0.0.1:19743'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with api.open(req,timeout=30) as r:return json.load(r)
def docker(*args):return subprocess.check_output(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test',*args],text=True)
call('/api/login',{'password':'native-test-password'})
subprocess.run(['docker','--context','colima-codoxear-test','exec','-d','codoxear-harmony-test','python3','/workspace/frontend/harmonyos/tests/fixture_backend.py',sid],check=True)
for _ in range(30):
 row=next((r for r in call('/api/sessions')['sessions'] if r['session_id']==sid),None)
 if row:break
 time.sleep(.3)
assert row and row['cwd']=='/home/tester/native-parity-fixture'
call('/api/sessions/'+sid+'/edit',{'name':alias})
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session(alias)
text='REMOVED_SESSION_DRAFT_'+str(time.time_ns());u.type_at('message-input',text,True)
u.click('Queue');u.node('Queue is empty.')
# Only the exact container fixture created above may be deleted.
pid=row['broker_pid'];docker('python3','-c',f"import os,signal;from pathlib import Path;args=Path('/proc/{pid}/cmdline').read_bytes().split(bytes([0]));assert b'/workspace/frontend/harmonyos/tests/fixture_backend.py' in args and {sid.encode()!r} in args;os.kill({pid},signal.SIGTERM)")
call('/api/sessions/'+sid+'/delete',{})
u.node('New session')
for _ in range(20):
 if not any(n.get('id')=='message-input' for n in u.layout()):break
 time.sleep(.3)
assert not any(n.get('id')=='message-input' for n in u.layout()),'Removed session composer is still active'
u.capture('../../../artifacts/harmonyos/native-session-removed.png')
# Recreate only the same fixture ID to prove its local unsent draft survived.
subprocess.run(['docker','--context','colima-codoxear-test','exec','-d','codoxear-harmony-test','python3','/workspace/frontend/harmonyos/tests/fixture_backend.py',sid],check=True)
for _ in range(30):
 row=next((r for r in call('/api/sessions')['sessions'] if r['session_id']==sid),None)
 if row:break
 time.sleep(.3)
assert row
call('/api/sessions/'+sid+'/edit',{'name':alias})
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session(alias)
assert u.node('message-input')['text']==text
u.capture('../../../artifacts/harmonyos/native-session-draft-restored.png')
assert not any(e.get('text')==text for e in call('/api/sessions/'+sid+'/messages/tail?limit=80')['events'])
u.type_at('message-input','',True)
pid=row['broker_pid'];docker('python3','-c',f"import os,signal;from pathlib import Path;args=Path('/proc/{pid}/cmdline').read_bytes().split(bytes([0]));assert b'/workspace/frontend/harmonyos/tests/fixture_backend.py' in args and {sid.encode()!r} in args;os.kill({pid},signal.SIGTERM)")
call('/api/sessions/'+sid+'/delete',{})
print('PASS external session removal closes stale queue/composer, returns catalog; unsent draft survives restart and same-ID recovery with no delivery')
