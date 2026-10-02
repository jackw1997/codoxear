"""Prose file recognition and memory citation open actual native files at lines."""
import time,re
import native_ui as u
def tap_text(label):
    n=u.node(label);x,y,r,b=map(int,re.findall(r'\d+',n['bounds']))
    u.run('shell','uitest','uiInput','click',str(x+70),str((y+b)//2));time.sleep(.7)
def latest():
    if any(n.get('id')=='Latest messages' for n in u.layout()):u.click('Latest messages')
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.type_at('message-input','native-line-target.py:40',True);u.click('Send');time.sleep(2);latest()
u.capture('../../../artifacts/harmonyos/native-chat-file-reference.png')
tap_text('native-line-target.py:40')
u.node('value_40 = 40');assert not any(n.get('text')=='value_1 = 1' for n in u.layout())
u.capture('../../../artifacts/harmonyos/native-chat-file-line.png');u.click('Close')
citation='<oai-mem-citation>\n<citation_entries>\nnative-citation-verification.md:40-42|note=[Native reference decision]\n</citation_entries>\n<rollout_ids>synthetic-private-rollout-id</rollout_ids>\n</oai-mem-citation>'
u.type_at('message-input',citation,True);u.click('Send');time.sleep(2);latest()
u.node('Memory citations:');u.node('Native reference decision')
assert not any('synthetic-private-rollout-id' in n.get('text','') for n in u.layout())
u.capture('../../../artifacts/harmonyos/native-memory-citation.png');tap_text('Native reference decision')
u.node('Native memory reference line 40');u.capture('../../../artifacts/harmonyos/native-memory-line.png')
print('PASS native prose file:line and memory citation to native source line 40')
