"""Create a real isolated CLI session through the native form (tmux/resume)."""
import json,time,sys,urllib.request,http.cookiejar,urllib.parse,subprocess
import native_ui as u
backend=sys.argv[1];resume=sys.argv[2] if len(sys.argv)>2 else ''
assert backend in ('pi','codex','cc')
jar=http.cookiejar.CookieJar();api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,data=None):
    req=urllib.request.Request('http://127.0.0.1:19743'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    with api.open(req,timeout=40) as r:return json.load(r)
call('/api/login',{'password':'native-test-password'})
name='Native '+('resume ' if resume else 'tmux ')+backend
cwd='/home/tester/native-cli-smoke'
assert not any(r.get('alias')==name for r in call('/api/sessions')['sessions']), 'Existing test session; do not duplicate'
def find(label):
    for n in u.layout():
        if n.get('id')==label or n.get('text')==label or n.get('hint')==label:
            x,y,r,b=map(int,u.re.findall(r'\d+',n['bounds']))
            if b>y and r>x and 180<y<2600:return n
    return None
def reveal(label):
    for _ in range(12):
        n=find(label)
        if n:return n
        u.run('shell','uitest','uiInput','swipe','1150','2350','1150','1000','500');time.sleep(.4)
    raise AssertionError('Could not scroll to '+label)
def field(label,value):
    reveal(label);u.type_at(label,value,True)
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.click('New session');u.click({'pi':'Pi','codex':'Codex','cc':'Claude Code'}[backend])
field('Session name (optional)',name);field('Working directory',cwd)
if backend=='codex':
    reveal('launch-provider');u.click('launch-provider');u.click('chatgpt')
if backend=='pi':
    reveal('launch-provider');u.click('launch-provider');u.click('new-api-glm')
field('Model',{'pi':'glm-5.2','codex':'gpt-6-astra','cc':'sonnet'}[backend])
if resume:field('Resume session ID',resume)
reveal('Create session');u.click('Create session')
for _ in range(40):
    rows=call('/api/sessions')['sessions'];hits=[r for r in rows if r.get('alias')==name]
    if hits and hits[0].get('log_path'):break
    time.sleep(1)
assert len(hits)==1,'Created session never acquired its name'
row=hits[0];assert row.get('log_path'), 'Created session did not bind a conversation log before sending';sid=row['session_id'];assert row.get('cwd')==cwd and row.get('agent_backend')==backend
# The real UI must automatically select the just-created session.
assert u.node('chat-keyboard')['text']==name
if resume:
    assert row.get('thread_id')==resume, 'Resume bound the wrong session'
    page=call('/api/sessions/'+sid+'/messages/tail?limit=100')
    old_marker='NATIVE_TMUX_'+backend.upper()+'_'
    old_reply=next(e['text'] for e in page['events'] if e.get('role')=='assistant' and old_marker in e.get('text',''))
    assert u.node(old_reply), 'Previous conversation was not restored'
marker='NATIVE_'+('RESUME_' if resume else 'TMUX_')+backend.upper()+'_'+str(time.time_ns())
u.type_at('message-input','Reply exactly '+marker+'. Do not use tools or read files.',True);u.click('Send')
for _ in range(90):
    if any(n.get('text')==marker for n in u.layout()):break
    time.sleep(1)
else:raise AssertionError('No real reply rendered')
rows=call('/api/sessions')['sessions'];row=next(r for r in rows if r.get('alias')==name)
assert row.get('log_path') and not row.get('lost')
assert row.get('transport')=='tmux'
panes=subprocess.check_output(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','tmux','list-panes','-a','-F','#{pane_pid} #{pane_current_command}']).decode()
assert str(row['broker_pid']) in [line.split()[0] for line in panes.splitlines()]
print('PASS native launch/send/reply',name,'session',row['session_id'],'tmux panes',panes.strip(),flush=True)
from pathlib import Path
Path('/tmp/codoxear-native-'+('resume-' if resume else 'tmux-')+backend+'.json').write_text(json.dumps(row))
u.capture('../../../artifacts/harmonyos/native-'+('resume-' if resume else 'tmux-')+backend+'.png')
