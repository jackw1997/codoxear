"""Real document picker and isolated proxy faults; never use preview proxy19744."""
import http.cookiejar,json,subprocess,time,urllib.request
import native_ui as u

ENDPOINT='http://127.0.0.1:19746'
PROXY='codoxear-native-upload-proxy'
FLAGS=('delay-upload','reject-upload','drop-upload-response')
client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
client.open(urllib.request.Request(ENDPOINT+'/api/login',data=json.dumps({'password':'native-test-password'}).encode(),headers={'Content-Type':'application/json'})).read()
def api(path):return json.load(client.open(ENDPOINT+path))
sid=next(s['session_id'] for s in api('/api/sessions')['sessions'] if s.get('alias')=='Native verified session')
def staged():return api('/api/sessions/'+sid+'/attachments')['attachments']
def faults(*names):
    subprocess.run(['docker','--context','colima-codoxear-test','exec',PROXY,'rm','-f',*('/tmp/'+f for f in FLAGS)],check=True,capture_output=True)
    if names:subprocess.run(['docker','--context','colima-codoxear-test','exec',PROXY,'touch',*('/tmp/'+f for f in names)],check=True,capture_output=True)
def wait_for(predicate,description,seconds=20):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        rows=u.layout()
        if predicate(rows):return rows
        time.sleep(.3)
    raise AssertionError(description)
def has(rows,label):return any(n.get('text')==label or n.get('id')==label for n in rows)
def pick():
    u.click('Attach files')
    n=next(n for n in u.layout() if n.get('text')=='Files')
    u.run('shell','uitest','uiInput','click',*u.center(n))
    rows=wait_for(lambda r:has(r,'最近') or has(r,'native-chart.png'),'Document picker')
    if not has(rows,'native-chart.png'):
        u.click('浏览');u.click('我的手机')
    u.click('native-chart.png')
def remove():
    u.click('Remove attachment')
    wait_for(lambda r:not has(r,'Remove attachment'),'Attachment removed')
    assert staged()==[]

faults()
try:
    u.run('shell','aa','force-stop','com.codoxear.mobile');u.login(ENDPOINT);u.select_session('Native verified session')
    # Remove only the single image staged while preparing this fixture.
    if staged():
        assert len(staged())==1 and staged()[0]['display_name']=='native-chart.png'
        remove()
    draft='Keep this draft after upload failure 中文😀'
    u.type_at('message-input',draft,True)
    before=api('/api/sessions/'+sid+'/messages/tail?limit=80')['events']
    faults('delay-upload','reject-upload');pick()
    wait_for(lambda r:has(r,'Uploading attachment…'),'Visible upload progress')
    assert u.node('Send').get('enabled') in ('false',False)
    u.click('Send')
    wait_for(lambda r:has(r,'Fixture upload rejected before staging'),'Upload rejection')
    assert u.node('message-input')['text']==draft and staged()==[]
    assert api('/api/sessions/'+sid+'/messages/tail?limit=80')['events']==before
    assert u.node('Send').get('enabled') in ('true',True)
    u.capture('../../../artifacts/harmonyos/native-upload-rejected.png')
    print('PASS delayed rejection: Send blocked, draft retained, no staging/delivery, controls restored',flush=True)

    faults();pick()
    wait_for(lambda r:has(r,'Remove attachment'),'Explicit retry stages image')
    assert len(staged())==1 and u.node('message-input')['text']==draft
    remove()
    faults('drop-upload-response');pick()
    wait_for(lambda r:has(r,'Remove attachment'),'Lost acknowledgement reconciles staged image')
    assert len(staged())==1 and u.node('message-input')['text']==draft
    faults();remove()
    print('PASS explicit retry and lost upload acknowledgement: staged list recovered without resubmission',flush=True)

    faults('delay-upload','reject-upload');pick()
    wait_for(lambda r:has(r,'Uploading attachment…'),'Late rejection starts upload')
    u.click('Sessions');u.select_session('Native visual comparison')
    time.sleep(9)
    rows=u.layout();assert not has(rows,'Fixture upload rejected before staging')
    assert not has(rows,'Uploading attachment…') and not has(rows,'Remove attachment')
    faults();u.click('Sessions');u.select_session('Native verified session')
    assert u.node('message-input')['text']==draft and staged()==[]
    u.type_at('message-input','',True)
    print('PASS late upload failure stays out of another session; original draft retained',flush=True)
finally:
    faults()
