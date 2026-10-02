"""Read a real newer Codex conversation through fresh Docker server/native UI."""
import json, urllib.request, http.cookiejar
import native_ui as u
jar=http.cookiejar.CookieJar(); api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,data=None):
    req=urllib.request.Request('http://127.0.0.1:19744'+path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json'})
    with api.open(req,timeout=30) as r:return json.load(r)
call('/api/login',{'password':'native-test-password'})
row=next(r for r in call('/api/sessions')['sessions'] if r.get('alias')=='Native tmux codex')
page=call('/api/sessions/'+row['session_id']+'/messages/tail?limit=100')
events=page['events']
user=next(e['text'] for e in events if e.get('role')=='user')
reply=next(e['text'] for e in events if e.get('role')=='assistant')
assert 'NATIVE_TMUX_CODEX_' in user and reply in user
assert all('environment_context' not in e.get('text','') for e in events)
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.click('Native tmux codex')
assert u.node(user) and u.node(reply)
u.capture('../../../artifacts/harmonyos/native-real-codex.png')
print('PASS actual retained Codex prompt/reply rendered natively, internal context excluded')
