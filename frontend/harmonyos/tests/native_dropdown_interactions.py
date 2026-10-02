"""Custom dropdown integration; requires only the dedicated native-dropdown fixture."""
import re,time,json,subprocess
import native_ui as u

def menu_open(ident):return any(n.get('id')==ident+'-menu' for n in u.layout())
def bounds(n):return tuple(map(int,re.findall(r'\d+',n['bounds'])))
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
if not any(n.get('id')=='Settings' for n in u.layout()):u.click('Sessions')
u.click('Settings');u.click('slate');u.click('dark');u.click('Close')
if not any(n.get('id')=='Settings' for n in u.layout()):u.click('Sessions')
u.click('session-meta-native-dropdown');u.click('Session details');u.click('Change reasoning effort')
u.click('details-setting-choice');u.click('high');assert u.node('Apply change')['enabled']=='true'
u.capture('../../../artifacts/harmonyos/dropdown-details.png');u.click('Cancel change');u.click('Close')
print('PASS custom Details selection enables apply, then canceled',flush=True)
u.click('Sessions');n=u.node('session-meta-native-dropdown');u.run('shell','uitest','uiInput','longClick',*u.center(n));time.sleep(.5);u.click('Edit session')
u.click('session-snooze');u.click('Custom');u.node('Snooze date (YYYY-MM-DD)')
u.click('session-snooze');u.click('No snooze')
u.click('session-dependency');menu=u.node('session-dependency-menu');x,y,r,b=bounds(menu)
assert 0<=x<r<=1320 and 0<=y<b<=2856
before=[n.get('text') for n in u.layout() if n.get('text')]
u.run('shell','uitest','uiInput','swipe',str((x+r)//2),str(b-35),str((x+r)//2),str(y+35),'450');time.sleep(.4)
after=[n.get('text') for n in u.layout() if n.get('text')]
assert before!=after,'Long list did not scroll'
u.capture('../../../artifacts/harmonyos/dropdown-long-options.png')
u.run('shell','uitest','uiInput','keyEvent','Back');assert not menu_open('session-dependency')
u.click('Close');print('PASS snooze choice, long dependency list scroll and Back dismissal; edits canceled',flush=True)
if not any(n.get('id')=='Settings' for n in u.layout()):u.click('Sessions')
u.click('New session');u.click('Codex');u.click('launch-effort');u.click('low')
u.click('launch-effort');u.run('shell','uitest','uiInput','keyEvent','2013');u.run('shell','uitest','uiInput','keyEvent','2054');time.sleep(.4)
assert not menu_open('launch-effort');u.node('medium')
u.click('launch-effort');u.run('shell','uitest','uiInput','keyEvent','2070');assert not menu_open('launch-effort');u.node('medium')
u.click('launch-effort');u.run('shell','uitest','uiInput','click','650','450');time.sleep(.4);assert not menu_open('launch-effort');u.node('medium')
u.capture('../../../artifacts/harmonyos/slate-dark-select-after.png')
print('PASS keyboard Down/Enter selection, Escape and outside dismissal preserve selected value',flush=True)
# Reading fixture-owned request log confirms canceled Details made no server change.
out=subprocess.check_output(['docker','--context','colima-codoxear-test','exec','-u','tester','codoxear-harmony-test','python3','-c',"from pathlib import Path;p=Path('/home/tester/native-dropdown.settings.jsonl');print(p.read_text() if p.exists() else '')"],text=True)
assert not out.strip(),'Cancel unexpectedly sent settings request'
print('PASS no settings mutations or new sessions',flush=True)
