"""Native confirmation keyboard/hint scope, explicit cancellation and deletion."""
import time
import native_ui as u
import native_send_boundaries as fixture

def key(*codes):
    u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def exists(label):return any(n.get('text')==label or n.get('id')==label for n in u.layout())
def open_delete():u.click('Remove queued message');u.node('Delete queued prompt?')

fixture.call('/api/login',{'password':'native-test-password'})
fixture.busy(True)
marker=f'Native confirmation deletion {time.time_ns()}'
fixture.call(f'/api/sessions/{fixture.sid}/enqueue',{'text':marker})
try:
    u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Send boundary verification');u.click('Queue');u.node(marker)
    open_delete();key(2070);u.node('Delete queued prompt?')
    for _ in range(4):
        key(2049)
        focused=[n for n in u.layout() if n.get('focused')=='true']
        assert any(n.get('id') in ('confirmation-cancel','confirmation-accept') for n in focused),focused
    key(2019);assert not exists('Delete queued prompt?');assert len(fixture.queue())==1
    open_delete();key(2022)
    badges=[n for n in u.layout() if n.get('id','').startswith('hint-')]
    assert len(badges)==2 and {n.get('description') for n in badges}=={'Cancel','Delete'},badges
    u.capture('../../../artifacts/harmonyos/native-confirmation-hints.png')
    key(2070);assert not any(n.get('id','').startswith('hint-') for n in u.layout());u.node('Delete queued prompt?')
    key(2022);key(2019);assert not exists('Delete queued prompt?');assert len(fixture.queue())==1
    open_delete();key(2020)
    fixture.wait(lambda:not fixture.queue());assert fixture.count(marker)==0
    assert not exists('Delete queued prompt?')
    u.capture('../../../artifacts/harmonyos/native-confirmation-deleted.png')
    print('PASS confirmation Escape retains dialog; Tab stays inside; c cancels; f shows only two scoped hints; d explicitly deletes without sending')
finally:
    # Leave no queued prompt able to drain after the test.
    for item in fixture.queue():fixture.call(f'/api/sessions/{fixture.sid}/queue/delete',{'id':item['id']})
    fixture.busy(False)
