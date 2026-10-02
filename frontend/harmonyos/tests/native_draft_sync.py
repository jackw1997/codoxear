"""Real native composer and a second HTTP client, using only an owned Docker fixture."""
import json, time, subprocess, urllib.request, http.cookiejar
import native_ui as u
sid='native-drafts-'+str(time.time_ns())
alias='Draft sync verification'
api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def call(path,data=None):
    req=urllib.request.Request('http://127.0.0.1:19743'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    with api.open(req,timeout=30) as r:return json.load(r)
def wait_value(read,expected):
    end=time.monotonic()+18
    while time.monotonic()<end:
        actual=read()
        if actual==expected:return
        time.sleep(.4)
    raise AssertionError((expected,actual))
def composer():return u.node('message-input').get('text','')
def restart():
    u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
    if not any(n.get('id')=='chat-keyboard' and n.get('text')==alias for n in u.layout()):u.select_session(alias)
call('/api/login',{'password':'native-test-password'})
subprocess.run(['docker','--context','colima-codoxear-test','exec','-d','-e','CODOXEAR_NATIVE_FIXTURE_CWD=/home/tester/'+sid,'codoxear-harmony-test','python3','/workspace/frontend/harmonyos/tests/fixture_backend.py',sid],check=True)
row=None
try:
    for _ in range(30):
        row=next((r for r in call('/api/sessions')['sessions'] if r['session_id']==sid),None)
        if row:break
        time.sleep(.3)
    assert row and row['cwd']=='/home/tester/'+sid
    path='/api/sessions/'+sid+'/draft'
    call('/api/sessions/'+sid+'/edit',{'name':alias})
    call(path,{'text':'Other device draft 中文 🐟'})
    restart();wait_value(composer,'Other device draft 中文 🐟')
    call(path,{'text':'Changed on other device'});wait_value(composer,'Changed on other device')
    call(path,{'text':''});wait_value(composer,'')
    u.capture('../../../artifacts/harmonyos/native-draft-remote-clear.png')
    print('PASS initial remote draft, live remote edit, remote empty tombstone',flush=True)
    u.type_at('message-input','Native draft 中文 🐟',True)
    wait_value(lambda:call(path)['text'],'Native draft 中文 🐟')
    restart();wait_value(composer,'Native draft 中文 🐟')
    print('PASS native-to-server write and force-stop restoration',flush=True)
    u.run('shell','aa','force-stop','com.codoxear.mobile')
    call(path,{'text':'Edited while native was closed'})
    restart();wait_value(composer,'Edited while native was closed')
    u.capture('../../../artifacts/harmonyos/native-draft-remote-restart.png')
    u.run('shell','aa','force-stop','com.codoxear.mobile')
    call(path,{'text':''})
    restart();wait_value(composer,'')
    assert not any(e.get('text','').startswith(('Other device','Native draft','Edited while')) for e in call('/api/sessions/'+sid+'/messages/tail?limit=80')['events'])
    print('PASS newer remote edit and deletion replace cached draft after restart; no messages sent',flush=True)
finally:
    if row:
        pid=row['broker_pid']
        cleanup=f"import os,signal;from pathlib import Path;args=Path('/proc/{pid}/cmdline').read_bytes().split(bytes([0]));assert b'/workspace/frontend/harmonyos/tests/fixture_backend.py' in args and {sid.encode()!r} in args;os.kill({pid},signal.SIGTERM)"
        subprocess.run(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','python3','-c',cleanup],check=True)
        call('/api/sessions/'+sid+'/delete',{})
