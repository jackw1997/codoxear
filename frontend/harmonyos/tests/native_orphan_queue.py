"""Native review of durable recovery after the original broker has disappeared."""
import json,time,urllib.request,http.cookiejar
from pathlib import Path
import native_ui as u
record=json.loads(Path('/tmp/codoxear-native-orphan-queue.json').read_text());sid=record['sid']
assert sid=='native-orphan-review'
api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def call(path,data=None):
 req=urllib.request.Request('http://127.0.0.1:19743'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with api.open(req,timeout=30) as r:return json.load(r)
def queue():return call('/api/sessions/'+sid+'/queue')['items']
def row():return next((r for r in call('/api/sessions')['sessions'] if r['session_id']==sid),None)
call('/api/login',{'password':'native-test-password'})
assert row() and row()['orphan_recovery'] and len(queue())==2
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session(row()['alias'])
u.type_at('message-input','Do not send to a missing session',True);u.click('Send');u.node('Missing session can only be reviewed.')
assert len(queue())==2 and u.node('message-input')['text']=='Do not send to a missing session'
u.click('Queue');u.node(record['first']);u.node(record['second'])
assert all(n.get('enabled')=='false' for n in u.layout() if n.get('id') in ('Edit queued message','Move up','Move down'))
u.capture('../../../artifacts/harmonyos/native-orphan-queue.png')
u.click('Remove queued message');u.click('Cancel');assert len(queue())==2
u.click('Remove queued message');u.click('Delete')
for _ in range(20):
 if len(queue())==1:break
 time.sleep(.2)
assert len(queue())==1 and row()['orphan_recovery']
u.click('Remove queued message');u.click('Delete');u.node('New session')
assert row() is None and not any(n.get('id')=='message-input' for n in u.layout())
u.capture('../../../artifacts/harmonyos/native-orphan-cleared.png')
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');assert row() is None
print('PASS missing-broker recovery blocks send/edit/reorder; cancel retains records; explicit final deletion clears selected session and remains absent after restart')
