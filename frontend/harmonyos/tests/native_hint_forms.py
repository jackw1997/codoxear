"""Hints focus native form fields/selects and toggle switches without submitting."""
import time,re
import native_ui as u

def key(*codes):u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def badges():return [n for n in u.layout() if n.get('id','').startswith('hint-')]
def activate(label):
 target=u.node(label);x,y=map(int,re.findall(r'\d+',target['bounds'])[:2]);key(2022)
 rows=badges();assert rows, 'No hints for '+label
 row=min(rows,key=lambda n:sum((a-b)**2 for a,b in zip(map(int,re.findall(r'\d+',n['bounds'])[:2]),[x,y])))
 assert abs(int(re.findall(r'\d+',row['bounds'])[0])-x)<5,(label,row['bounds'])
 for c in row['text']:key(2017+ord(c)-97 if c.isalpha() else 2000+int(c))

def leave_entry():
 for _ in range(12):
  key(2049)
  if not any(n.get('focused')=='true' and n.get('type') in ('TextInput','TextArea') for n in u.layout()):return
 raise AssertionError('Could not tab out of entry')

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.click('message-input');key(2070);activate('chat-keyboard');u.node('session-snooze')
activate('Session name');assert u.node('Session name')['focused']=='true'
u.run('shell','uitest','uiInput','text','f');assert not badges()
leave_entry();activate('session-snooze');assert u.node('session-snooze')['focused']=='true'
key(2054);u.node('Tomorrow');u.click('No snooze');u.click('Close')
# Unsaved unattended switch changes stay local; close without Save.
u.click('Unattended');switch=next(n for n in u.layout() if n.get('type')=='Toggle');before=switch.get('checked')
key(2022);rows=badges();sx,sy=map(int,re.findall(r'\d+',switch['bounds'])[:2]);row=min(rows,key=lambda n:abs(int(re.findall(r'\d+',n['bounds'])[1])-sy))
for c in row['text']:key(2017+ord(c)-97)
switch=next(n for n in u.layout() if n.get('type')=='Toggle');assert switch.get('checked')!=before
activate('unattended-request');assert u.node('unattended-request')['focused']=='true'
u.run('shell','uitest','uiInput','text','f stays in the prompt');assert not badges()
u.click('Close');u.node('message-input')
# Pointer activity dismisses all badges before the control action runs.
u.click('message-input');key(2070);key(2022);assert badges();u.click('Files');assert not badges();u.node('Close')
print('PASS hinted title/edit field, literal f, native select focus/Enter menu, unsaved switch/prompt focus and pointer cancellation')
