"""Real legacy pending attachment requires explicit confirmation before delivery."""
import http.cookiejar,json,time,urllib.request
import native_ui as u
sid='native-legacy-attachment';api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def call(path,data=None):
 req=urllib.request.Request('http://127.0.0.1:19748'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with api.open(req,timeout=30) as r:return json.load(r)
def session():return next(s for s in call('/api/sessions')['sessions'] if s['session_id']==sid)
def count(marker):return sum(e.get('role')=='user' and marker in e.get('text','') for e in call(f'/api/sessions/{sid}/messages/tail?limit=30')['events'])
call('/api/login',{'password':'native-test-password'});call(f'/api/sessions/{sid}/rename',{'name':'Legacy attachment verification'})
assert session()['pending_attachment'];assert not call(f'/api/sessions/{sid}/attachments')['attachments']
u.run('rport','tcp:19748','tcp:19748')
marker='Legacy pending attachment '+str(time.time_ns())
try:
 u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19748');u.select_session('Legacy attachment verification')
 u.type_at('message-input',marker,True);u.click('Send');u.node('Send pending attachment?')
 assert count(marker)==0
 u.capture('../../../artifacts/harmonyos/native-legacy-attachment-confirm.png')
 u.click('Cancel');assert u.node('message-input')['text']==marker;assert count(marker)==0 and session()['pending_attachment']
 u.click('Send');u.node('Send pending attachment?');u.click('Send with attachment')
 end=time.monotonic()+12
 while time.monotonic()<end and count(marker)!=1:time.sleep(.3)
 assert count(marker)==1 and not session()['pending_attachment']
 assert u.node('message-input').get('text','')==''
 u.capture('../../../artifacts/harmonyos/native-legacy-attachment-sent.png')
 print('PASS legacy pending with no staged records: Cancel preserves draft/pending/no commit; explicit confirmation delivers once and clears pending/draft')
finally:
 u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
