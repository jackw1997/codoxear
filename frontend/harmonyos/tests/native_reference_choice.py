"""Ambiguous prose paths require a choice; directory links only open launch options."""
import time,re
import native_ui as u
def tap(label):
 n=u.node(label);x,y,r,b=map(int,re.findall(r'\d+',n['bounds']))
 u.run('shell','uitest','uiInput','click',str(x+70),str((y+b)//2));time.sleep(.7)
def send(text):
 u.type_at('message-input',text,True);u.click('Send');time.sleep(3)
 if any(n.get('id')=='Latest messages' for n in u.layout()):u.click('Latest messages')
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
send('native-duplicate-reference.py:40');tap('native-duplicate-reference.py:40')
u.node('native-choice-a/native-duplicate-reference.py');u.node('native-choice-b/native-duplicate-reference.py')
u.capture('../../../artifacts/harmonyos/native-reference-choice.png')
u.click('native-choice-b/native-duplicate-reference.py');u.node('native_choice_b_line_40 = 40')
assert not any(n.get('text')=='native_choice_a_line_40 = 40' for n in u.layout())
u.click('Close');send('./native-choice-a');tap('./native-choice-a')
u.node('Working directory')
assert any(n.get('text')=='/home/tester/native-parity-fixture/native-choice-a' for n in u.layout())
u.capture('../../../artifacts/harmonyos/native-directory-reference.png');u.click('Close')
print('PASS ambiguous reference shows both choices, selected line 40, directory only opens launch form')
