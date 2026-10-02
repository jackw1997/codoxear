"""Actual native priority extremes, custom validation and tomorrow scheduling."""
import datetime,json,re,runpy,time
import native_ui as u
api=runpy.run_path('/tmp/codoxear-cli-common.py');call=api['call'];sid='native-parity'
def row():return next(s for s in call('/api/sessions')['sessions'] if s['session_id']==sid)
original=row();restore={k:original.get(k) for k in ('priority_offset','snooze_until','dependency_session_id')};restore['name']=original.get('alias','')
def edit():u.click('chat-keyboard');u.node('Session name')
def menu(current,choice):u.click(current);u.click(choice)
def priority(value):
 slider=next(n for n in u.layout() if n.get('type')=='Slider');x,y,r,b=map(int,re.findall(r'\d+',slider['bounds']))
 u.run('shell','uitest','uiInput','click',str(x+2 if value<0 else r-2),str((y+b)//2));time.sleep(.3)
 u.node('Priority adjustment: '+format(value,'.2f'))
try:
 u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
 edit();priority(1);u.click('Save');assert row()['priority_offset']==1
 edit();priority(-1);u.click('Save');assert row()['priority_offset']==-1
 edit();u.click('Reset priority');menu('No snooze','Custom')
 u.type_at('Snooze date (YYYY-MM-DD)','2027-02-29',True);u.type_at('Snooze time (HH:mm)','09:30',True);u.click('Save')
 u.node('Choose a valid snooze date and time.');assert not row().get('snoozed')
 target=datetime.datetime.now().replace(hour=9,minute=30,second=0,microsecond=0)+datetime.timedelta(days=2)
 u.type_at('Snooze date (YYYY-MM-DD)',target.strftime('%Y-%m-%d'),True);u.click('Save')
 assert row()['snooze_until']==int(target.timestamp()),row()['snooze_until']
 edit();u.node(target.strftime('%Y-%m-%d'));u.node('09:30');menu('Custom','Tomorrow');u.click('Save')
 tomorrow=datetime.datetime.now().replace(hour=9,minute=0,second=0,microsecond=0)+datetime.timedelta(days=1)
 assert row()['snooze_until']==int(tomorrow.timestamp()),row()['snooze_until']
 u.click('Sessions');u.select_session('Native verified session');edit();u.capture('../../../artifacts/harmonyos/native-session-tomorrow.png')
 menu('Custom','No snooze');u.click('Save');assert not row().get('snoozed');assert row()['priority_offset']==0
 print('PASS native priority +1/-1/reset, invalid-date rejection, custom date persistence and Tomorrow at local 09:00')
finally:
 call('/api/sessions/'+sid+'/edit',restore)
