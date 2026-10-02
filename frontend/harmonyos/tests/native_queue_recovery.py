"""Real server recovery queue produced by a committed send with no broker reply.
Prepare only with the dedicated Docker native-recovery broker. No proxy data.
"""
import json,time,re,urllib.request,http.cookiejar,subprocess
from pathlib import Path
import native_ui as u
record=json.loads(Path('/tmp/codoxear-native-queue-recovery.json').read_text());sid=record['sid']
jar=http.cookiejar.CookieJar();api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path,data=None):
 req=urllib.request.Request('http://127.0.0.1:19743'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with api.open(req,timeout=30) as response:return json.load(response)
def queue():return call('/api/sessions/'+sid+'/queue')['items']
def events():return call('/api/sessions/'+sid+'/messages/tail?limit=100')['events']
def count(text):
 committed=subprocess.check_output(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','cat','/home/tester/native-recovery.committed.jsonl'],text=True)
 return sum(e.get('role')=='user' and e.get('text')==text for e in events())+sum(json.loads(line).get('text')==text for line in committed.splitlines())
def controls(label):return [n for n in u.layout() if n.get('id')==label]
def enabled(n):return str(n.get('enabled')).lower()=='true'
def tap(n):u.run('shell','uitest','uiInput','click',*u.center(n));time.sleep(.5)
call('/api/login',{'password':'native-test-password'})
assert len(queue())==2 and queue()[0].get('commit_unknown')
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Queue recovery verification');u.click('Queue')
u.node('Commit unknown');u.node(record['first']);u.node(record['second'])
assert not enabled(controls('Edit queued message')[0])
assert all(not enabled(n) for n in controls('Move up')+controls('Move down'))
assert enabled(controls('Remove queued message')[0])
assert count(record['first'])==1 and count(record['second'])==0
u.capture('../../../artifacts/harmonyos/native-queue-unknown.png')
# Cancellation leaves both the recovery record and the blocked following item.
tap(controls('Remove queued message')[0]);u.node('Delete recovery item?');u.click('Cancel')
assert len(queue())==2 and count(record['second'])==0
# Recovery deletion deliberately quarantines the following prompts. It must
# never cause the second prompt to be injected without separate review.
tap(controls('Remove queued message')[0]);u.click('Delete')
for _ in range(30):
 items=queue()
 if len(items)==1 and items[0].get('orphan_recovery'):break
 time.sleep(.2)
assert len(items)==1 and items[0].get('orphan_recovery')
assert count(record['first'])==1 and count(record['second'])==0
u.node('Recovery');assert not enabled(controls('Edit queued message')[0])
u.capture('../../../artifacts/harmonyos/native-queue-preserved.png')
tap(controls('Remove queued message')[0]);u.click('Cancel');assert len(queue())==1
tap(controls('Remove queued message')[0]);u.click('Delete')
assert not queue() and count(record['first'])==1 and count(record['second'])==0
u.capture('../../../artifacts/harmonyos/native-queue-recovered.png')
print('PASS real unknown commit and preserved recovery: edit/move locked, Cancel retains items, explicit deletion does not inject later prompts')
