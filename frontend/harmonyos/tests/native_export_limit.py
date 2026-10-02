"""Native real HTTP413 export failure preserves the clipboard and conversation."""
import http.cookiejar,json,time,urllib.request,urllib.error
import native_ui as u
sid='native-export-limit';api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def call(path,data=None):
 req=urllib.request.Request('http://127.0.0.1:19749'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with api.open(req,timeout=30) as r:return json.load(r)
call('/api/login',{'password':'native-test-password'})
try:call(f'/api/sessions/{sid}/messages/export');raise AssertionError('Expected export limit')
except urllib.error.HTTPError as e:
 assert e.code==413;assert json.load(e)['max_bytes']==1024
u.run('rport','tcp:19749','tcp:19749')
expected='Conversation too large to copy (max 1 KiB). Use search or copy a smaller range.'
try:
 u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19749');u.select_session('Export limit verification')
 text='Please review example.py and summarize the changes.\n请同时检查折叠前后的草稿与滚动位置。'
 u.click(text);u.click('Copy message')
 u.click('Session details');u.click('Copy conversation');u.click('Close');u.node(expected)
 u.capture('../../../artifacts/harmonyos/native-conversation-export-limit.png')
 u.click('message-input');u.run('shell','uitest','uiInput','keyEvent','2072','2038');time.sleep(.3)
 assert u.node('message-input')['text']==text
 assert len(call(f'/api/sessions/{sid}/messages/tail?limit=100')['events'])==2
 u.type_at('message-input','',True)
 print('PASS real export413 explains 1KiB limit; no clipboard overwrite; old conversation retained; draft cleared without sending')
finally:
 u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
