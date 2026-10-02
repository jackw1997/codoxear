"""Delete only a test-owned tmux CLI through native context menu; prove pane exit."""
import json,sys,time,subprocess,urllib.request,http.cookiejar
from pathlib import Path
import native_ui as u
backend=sys.argv[1];assert backend in ('pi','codex','cc')
mode=sys.argv[2] if len(sys.argv)>2 else 'tmux';assert mode in ('tmux','resume')
row=json.loads(Path('/tmp/codoxear-native-'+mode+'-'+backend+'.json').read_text())
assert row['alias']=='Native '+mode+' '+backend and row['cwd']=='/home/tester/native-cli-smoke' and row['transport']=='tmux'
jar=http.cookiejar.CookieJar();api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,data=None):
    req=urllib.request.Request('http://127.0.0.1:19743'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    with api.open(req,timeout=30) as r:return json.load(r)
call('/api/login',{'password':'native-test-password'})
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
u.run('shell','uitest','uiInput','longClick',*u.center(u.node(row['alias'])));time.sleep(.5);u.click('Delete');u.click('Delete')
for _ in range(30):
    rows=call('/api/sessions')['sessions']
    if not any(r['session_id']==row['session_id'] for r in rows):break
    time.sleep(.5)
assert not any(r['session_id']==row['session_id'] or r.get('launch_id')==row['launch_id'] for r in rows)
p=subprocess.run(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','tmux','list-panes','-a','-F','#{pane_pid}'],capture_output=True,text=True)
assert str(row['broker_pid']) not in p.stdout.splitlines()
print('PASS native Delete removed test session, stopped exact tmux pane, no synthetic launch failure',backend,flush=True)
