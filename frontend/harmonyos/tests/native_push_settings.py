"""Actual native notification consent, explicit fallback, and disable controls."""
import time
import native_ui as u

def reveal(label, partial=False):
    for _ in range(12):
        for node in u.layout():
            text=node.get('text','')
            if (label in text if partial else text==label) or node.get('id')==label:
                x,y,r,b=map(int,u.re.findall(r'\d+',node['bounds']))
                if r>x and b>y and 160<y and b<2740:return node
        u.run('shell','uitest','uiInput','swipe','1100','2300','1100','900','500');time.sleep(.25)
    raise AssertionError('Missing visible control: '+label)

u.run('shell','aa','force-stop','com.codoxear.mobile')
u.login('http://127.0.0.1:19745')
if not any(n.get('id')=='Settings' for n in u.layout()):u.click('Sessions')
u.click('Settings')
reveal('Enable notifications to receive session updates.',True)
u.run('shell','uitest','uiInput','click',*u.center(reveal('Enable notifications')));time.sleep(1)
labels={n.get('text') for n in u.layout()}
if '允许' in labels:u.click('允许')
reveal('App running only.',True)
u.capture('../../../artifacts/harmonyos/native-push-unconfigured.png')
print('Checking persisted opt-in after force-stop',flush=True)
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19745')
if not any(n.get('id')=='Settings' for n in u.layout()):u.click('Sessions')
u.click('Settings');reveal('App running only.',True)
u.run('shell','uitest','uiInput','click',*u.center(reveal('Disable notifications')));time.sleep(.5)
reveal('Notifications disabled')
assert not any(n.get('text')=='Disable notifications' for n in u.layout())
print('PASS native consent text, unconfigured background push accurately falls back to app-running delivery, preference survives restart, disable clears state')
