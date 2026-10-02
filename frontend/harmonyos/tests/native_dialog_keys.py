"""Native direct dialog letters, ambiguous buttons and text-entry isolation."""
import time
import native_ui as u

def key(*codes):
    u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def exists(label):return any(n.get('id')==label or n.get('text')==label for n in u.layout())

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
u.click('Help');key(2070);u.node('Close');key(2019)
assert not exists('Close'),'c did not close Help'
u.click('Sessions');u.select_session('Native visual comparison')
u.click('Session details');u.node('Copy conversation');key(2019)
u.node('Close');u.node('Copy conversation')  # c is ambiguous, so does nothing
key(2047,2028);assert not exists('Close'),'L did not activate distinctive Close letter'
u.click('Unattended');u.click('unattended-request')
u.run('shell','uitest','uiInput','text','cl remains text')
assert 'cl remains text' in u.node('unattended-request').get('text','')
key(2070);u.node('Close')
for _ in range(14):
    key(2049)
    if not any(n.get('focused')=='true' and n.get('type') in ('TextInput','TextArea') for n in u.layout()):break
else:raise AssertionError('Unable to leave input with Tab')
key(2019);assert not exists('Close'),'c did not close the unattended form'
# No Save: the test prompt must remain local and be discarded.
u.click('Unattended');assert 'cl remains text' not in u.node('unattended-request').get('text','');u.click('Close')
u.click('message-input');key(2070);key(2022);key(2018);u.node('Close')
key(2070);u.node('Close');u.click('Close')
u.capture('../../../artifacts/harmonyos/native-dialog-keys.png')
print('PASS Help c/Esc; Details ambiguous c and distinctive L; literal entry; Tab then c; unsaved form discarded; f/b and Escape dialog policy retained')
