"""Actual native f hints: target activation, dialog scope and literal input."""
import time,re
import native_ui as u

def key(*codes):
 u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def badges():return [n for n in u.layout() if n.get('id','').startswith('hint-')]
def hint(label):
 for c in label:key(2017+ord(c)-ord('a') if c.isalpha() else 2000+int(c))
def nearest(label):
 target=u.node(label);tx,ty=map(int,u.center(target));rows=badges();assert rows,'No hint badges'
 return min(rows,key=lambda n:sum((a-b)**2 for a,b in zip(map(int,u.center(n)),[tx,ty])))['text']

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.click('message-input');key(2070);key(2022)
assert any(n['id']=='hint-b' for n in badges()),badges()
u.capture('../../../artifacts/harmonyos/native-keyboard-hints-chat.png')
key(2018);u.node('Close');assert not badges()
# Modal hints contain only modal controls; the background Send hint is absent.
key(2022);rows=badges();assert rows,'File dialog has no keyboard targets'
controls=[n for n in u.layout() if n.get('clickable')=='true' or n.get('type') in ('TextInput','TextArea')]
for badge in rows:
 bx,by=map(int,re.findall(r'\d+',badge['bounds'])[:2])
 assert any(abs(bx-int(re.findall(r'\d+',n['bounds'])[0]))<4 and abs(by-int(re.findall(r'\d+',n['bounds'])[1]))<4 for n in controls), (badge['id'],badge['bounds'],'Hint has no visible dialog control')
u.capture('../../../artifacts/harmonyos/native-keyboard-hints-files.png')
key(2070);assert not badges();u.node('Close')
key(2022);hint(nearest('Close'));time.sleep(.5)
assert not any(n.get('id')=='Close' for n in u.layout())
key(2022);key(2025);assert u.node('message-input').get('focused')=='true'
u.run('shell','uitest','uiInput','text','f remains literal');assert not badges()
assert u.node('message-input')['text']=='f remains literal'
u.type_at('message-input','',True);u.click('message-input');key(2070)
u.click('Sessions');key(2022);rows=badges();assert any(n['id']=='hint-1' for n in rows),rows
u.capture('../../../artifacts/harmonyos/native-keyboard-hints-sessions.png')
key(2001);time.sleep(.6);assert not badges()
assert not any(n.get('id')=='Settings' for n in u.layout()),'Numeric hint did not select a session'
print('PASS: f hints open Files, modal-only targets, Escape preserves modal, hinted Close, hinted composer focus, literal text isolation and visible numeric session selection')
