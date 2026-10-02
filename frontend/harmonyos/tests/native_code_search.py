"""Search rendered code across its native syntax spans, with visual evidence."""
import time,uuid
import native_ui as u
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
marker='Code search verification '+str(time.time_ns())
identifier='a'+uuid.uuid4().hex[:4]
query=identifier+' = "中文😀"'
code='const '+query+';'
message=marker+'\n```javascript\n'+code+'\n```'
u.type_at('message-input',message,True);u.click('Send')
for _ in range(20):
    if any('Fixture acknowledged: '+marker in n.get('text','') for n in u.layout()):break
    time.sleep(.5)
u.click('Search conversation');u.type_at('Search conversation',query,True);u.click('Search')
u.node('2 matches')
rows=u.layout();hit=next(n for n in rows if marker in n.get('text','') and n.get('type')=='Text')
u.run('shell','uitest','uiInput','click',*u.center(hit));time.sleep(1)
u.node(code);u.node('Close search')
u.capture('../../../artifacts/harmonyos/native-code-search.png')
print('PASS native search opens code match with exact source preserved; inspect yellow highlight in capture')
