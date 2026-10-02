"""Touch copy affordance and full conversation copy via the actual native UI."""
import json,time,urllib.request,http.cookiejar
import native_ui as u
jar=http.cookiejar.CookieJar();api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,data=None):
    req=urllib.request.Request('http://127.0.0.1:19743'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    with api.open(req,timeout=30) as r:return json.load(r)
call('/api/login',{'password':'native-test-password'})
row=next(r for r in call('/api/sessions')['sessions'] if r.get('alias')=='Native resume pi')
events=call('/api/sessions/'+row['session_id']+'/messages/tail?limit=100')['events']
reply=[e['text'] for e in events if e.get('role')=='assistant'][-1]
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.click('Native resume pi')
assert not any(n.get('id')=='Copy message' for n in u.layout())
u.click(reply);u.click('Copy message')
u.click('message-input');u.run('shell','uitest','uiInput','keyEvent','2072','2038');time.sleep(.5)
assert u.node('message-input')['text']==reply
u.type_at('message-input','',True)
u.click('Session details');u.click('Copy conversation');u.run('shell','uitest','uiInput','keyEvent','Back')
u.click('message-input');u.run('shell','uitest','uiInput','keyEvent','2072','2038');time.sleep(.5)
text=u.node('message-input')['text']
assert 'NATIVE_TMUX_PI_' in text and 'NATIVE_RESUME_PI_' in text
assert all(e['text'] in text for e in events if e.get('role') in ('user','assistant'))
u.type_at('message-input','',True)
u.capture('../../../artifacts/harmonyos/native-touch-copy.png')
print('PASS tap reveals per-message copy, exact clipboard paste, Details conversation copy includes old and new turns')
