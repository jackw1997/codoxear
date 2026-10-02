"""Real native send boundaries against the dedicated Docker synthetic broker.
Never point this test at a user's preview emulator or a production backend.
"""
import base64, json, subprocess, time, urllib.request, http.cookiejar
from pathlib import Path
import native_ui as u

sid='native-send-boundary'
jar=http.cookiejar.CookieJar(); api=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path, data=None):
    req=urllib.request.Request('http://127.0.0.1:19743'+path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json'})
    with api.open(req,timeout=35) as response: return json.load(response)
def docker(code):
    return subprocess.check_output(['docker','--context','colima-codoxear-test','exec','-u','tester','codoxear-harmony-test','python','-c',code],text=True)
def flag(name,on):
    docker(f"from pathlib import Path;p=Path('/home/tester/{sid}.{name}');p.touch()" if on else f"from pathlib import Path;Path('/home/tester/{sid}.{name}').unlink(missing_ok=True)")
def attachments():return call(f'/api/sessions/{sid}/attachments')['attachments']
def queue():return call(f'/api/sessions/{sid}/queue')['items']
def events():return call(f'/api/sessions/{sid}/messages/tail?limit=100')['events']
def count(text):return sum(e.get('role')=='user' and text in e.get('text','') for e in events())
def wait(check,seconds=12):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if check():return
        time.sleep(.2)
    raise AssertionError('Timed out waiting for server state')
def busy(value):
    flag('busy',value)
    row={'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'type':'event_msg','payload':{'type':'user_message','message':'Synthetic busy gate','images':[]} if value else {'type':'task_complete','last_agent_message':'Synthetic gate finished'}}
    docker(f"from pathlib import Path;p=Path('/home/tester/{sid}.jsonl');f=p.open('a');f.write({json.dumps(row)!r}+'\\n');f.close()")
    wait(lambda: next(s for s in call('/api/sessions')['sessions'] if s['session_id']==sid).get('busy')==value)

def main():
    call('/api/login',{'password':'native-test-password'})
    assert not queue(), 'Dedicated fixture must have an empty queue'
    for attachment in attachments():call(f'/api/sessions/{sid}/attachments/delete',{'id':attachment['id']})
    call(f'/api/sessions/{sid}/inject_file',{'filename':'boundary.txt','data_b64':base64.b64encode(b'Native attachment send evidence').decode()})
    marker=f'Native injection retry {time.time_ns()}'
    u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Send boundary verification')
    u.node('boundary.txt');u.type_at('message-input',marker,True)
    flag('reject-send',True);u.click('Send');u.node('Synthetic attachment injection rejected')
    assert u.node('message-input')['text']==marker and len(attachments())==1 and count(marker)==0
    u.capture('../../../artifacts/harmonyos/native-attachment-injection-rejected.png')
    u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Send boundary verification')
    assert u.node('message-input')['text']==marker;u.node('boundary.txt')
    u.click('Send');wait(lambda: count(marker)==1 and not attachments())
    assert u.node('message-input').get('text','')==''
    u.capture('../../../artifacts/harmonyos/native-attachment-injection-retried.png')
    print('PASS rejected attachment injection preserves staged file and draft across restart; explicit retry commits once and clears staging',flush=True)

    check_queue()

def check_queue():
    first=f'Native queue sending {time.time_ns()}';second=f'Native queue following {time.time_ns()}'
    busy(True)
    call(f'/api/sessions/{sid}/enqueue',{'text':first});call(f'/api/sessions/{sid}/enqueue',{'text':second})
    assert len(queue())==2
    u.click('Queue');u.node(first);u.node(second)
    flag('hold-send',True)
    try:
        busy(False);wait(lambda: bool(queue()) and queue()[0].get('sending'),20);u.node('Sending')
        rows=u.layout();controls=lambda label:[n for n in rows if n.get('id')==label]
        enabled=lambda node:str(node.get('enabled')).lower()=='true'
        assert not enabled(controls('Edit queued message')[0])
        assert not enabled(controls('Remove queued message')[0])
        assert all(not enabled(n) for n in controls('Move up')+controls('Move down'))
        items=queue()
        assert enabled(controls('Edit queued message')[1]) == (not bool(items[1].get('orphan_recovery') or items[1].get('commit_unknown')))
        assert enabled(controls('Remove queued message')[1])
        assert items[0]['sending'] and count(first)==0 and count(second)==0
        u.capture('../../../artifacts/harmonyos/native-queue-sending.png')
    finally:flag('hold-send',False)
    wait(lambda:not queue() and count(first)==1 and count(second)==1,40)
    wait(lambda:not any(n.get('text')=='Sending' for n in u.layout()))
    u.capture('../../../artifacts/harmonyos/native-queue-sent.png')
    print('PASS active queue head disables edit/delete/move; following item cannot cross it; both commit once after acknowledgement',flush=True)

if __name__=='__main__':main()
