"""A rejected offline send preserves a multiline draft and retries exactly once."""
import time,subprocess,json,urllib.request,http.cookiejar
import native_ui as u
jar=http.cookiejar.CookieJar();api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,data=None):
    req=urllib.request.Request('http://127.0.0.1:19743'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    with api.open(req,timeout=30) as r:return json.load(r)
def fault(on):
    subprocess.run(['docker','--context','colima-codoxear-test','exec','codoxear-native-auth-proxy',*(['touch','/tmp/network-unavailable'] if on else ['rm','-f','/tmp/network-unavailable'])],check=True)
def choose():
    for _ in range(10):
        if any(n.get('text')=='Native verified session' for n in u.layout()):break
        u.run('shell','uitest','uiInput','swipe','650','2350','650','900','500')
    u.click('Native verified session')
call('/api/login',{'password':'native-test-password'})
row=next(r for r in call('/api/sessions')['sessions'] if r.get('alias')=='Native verified session');sid=row['session_id']
marker='NATIVE_OFFLINE_'+str(time.time_ns());draft=marker+'\n中文离线草稿\nThird line'
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');choose();u.type_at('message-input',draft,True)
try:
    fault(True);u.click('Send');time.sleep(10)
    assert u.node('message-input')['text']==draft
    assert all(marker not in e.get('text','') for e in call('/api/sessions/'+sid+'/messages/tail?limit=100')['events'])
    u.capture('../../../artifacts/harmonyos/native-offline-draft.png')
finally:fault(False)
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');choose()
assert u.node('message-input')['text']==draft
u.click('Send')
for _ in range(30):
    events=call('/api/sessions/'+sid+'/messages/tail?limit=100')['events']
    hits=[e for e in events if e.get('role')=='user' and e.get('text')==draft]
    if hits and u.node('message-input')['text']=='':break
    time.sleep(.5)
assert len(hits)==1 and u.node('message-input')['text']==''
print('PASS rejected offline send, multiline draft persistence across restart and exactly one retry delivery')
