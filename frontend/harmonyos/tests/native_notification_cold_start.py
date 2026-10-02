"""Actual posted system notification, process stop, shade tap, login and route."""
import time,re
import native_ui as u

def visible(label):
    for n in u.layout():
        if n.get('text')==label or n.get('id')==label:
            bounds=list(map(int,re.findall(r'-?\d+',n.get('bounds',''))))
            if len(bounds)==4 and bounds[1]>=140 and bounds[3]<2740:return True
    return False

def reveal(label):
    for _ in range(8):
        if visible(label):return
        u.run('shell','uitest','uiInput','swipe','1150','2350','1150','700','700');time.sleep(.4)
    raise AssertionError('Control not visible: '+label)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
if not visible('Settings'):u.click('Sessions')
u.select_session('Native verified session');u.click('Sessions');u.click('Settings');reveal('Enable notifications');u.click('Enable notifications');time.sleep(1)
assert any(n.get('text')=='Disable notifications' for n in u.layout())
u.click('Close')
if visible('Native verified session') and not visible('message-input'):u.click('Native verified session')
text='Native cold-start notification '+str(time.time_ns())
u.type_at('message-input',text,True);u.click('Send');time.sleep(8)
u.run('shell','aa','force-stop','com.codoxear.mobile')
u.run('shell','uitest','uiInput','swipe','500','20','500','2200','700');time.sleep(1)
rows=u.layout();hit=next((n for n in rows if text in n.get('text','')),None)
assert hit,'No posted notification after process stop'
u.capture('../../../artifacts/harmonyos/native-notification-cold-shade.png')
u.run('shell','uitest','uiInput','click',*u.center(hit));time.sleep(2)
rows=u.layout();assert any(n.get('id')=='password' for n in rows),'Notification did not launch login'
server=next(n for n in rows if n.get('id')=='Server address');assert server.get('text')=='http://127.0.0.1:19744',server
u.type_at('password','native-test-password',True);u.click('Login');time.sleep(3)
assert u.node('chat-keyboard').get('text')=='Native verified session'
assert any(text in n.get('text','') for n in u.layout()),'Login did not open the notification conversation'
u.capture('../../../artifacts/harmonyos/native-notification-cold-route.png')
print('PASS: posted notification survives process stop, actual shade tap launches login, server and conversation route retained through authentication')
