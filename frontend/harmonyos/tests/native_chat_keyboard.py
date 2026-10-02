"""Real hardware-key event routing, composer isolation and native modal focus."""
import time,re
import native_ui as u

def key(*codes):
    u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.35)
def texts():return '\n'.join(n.get('text','') for n in u.layout() if n.get('text'))
def focused(label):return u.node(label).get('focused')=='true'
def body():return [(n.get('text'),n.get('bounds')) for n in u.layout() if 'History user' in n.get('text','') or 'History assistant' in n.get('text','')]

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('History verification')
u.type_at('message-input','',True);u.click('message-input');key(2070)
assert focused('chat-keyboard'),'Esc did not leave the composer'
key(2025);assert focused('message-input')
assert u.node('message-input').get('text')=='','i was inserted instead of focusing'
u.run('shell','uitest','uiInput','text','ijkduD/ typed normally')
assert u.node('message-input').get('text')=='ijkduD/ typed normally'
key(2070);assert focused('chat-keyboard')
# Scroll up and down using the real keyboard while retaining the draft.
key(2047,2023);u.click('message-input');key(2070)
before=texts();key(2037);after=texts();assert before!=after,'u did not scroll upward'
key(2047,2023);assert 'History question 099' in texts() or 'History answer 099' in texts(),texts()
assert u.node('message-input').get('text')=='ijkduD/ typed normally'
key(2064);assert u.node('Close')
for i in range(14):
    key(2049)
    assert not any(n.get('id') in ['message-input','chat-keyboard'] and n.get('focused')=='true' for n in u.layout()),'Tab escaped the modal'
key(2070);u.node('Close');assert not focused('chat-keyboard'),'Esc closed a modal'
u.click('Close');assert focused('chat-keyboard'),'Close did not restore conversation focus'
# The delete shortcut must request confirmation, never directly delete.
key(2047,2020);assert 'Delete session?' in texts(),texts()
u.click('Cancel')
u.type_at('message-input','',True);key(2070)
u.click('Sessions');u.select_session('Native verified session')
u.type_at('message-input','Native Meta Enter verification',True);u.click('message-input');key(2076,2054);time.sleep(2)
assert u.node('message-input').get('text')=='','Meta+Enter did not send'
assert 'Native Meta Enter verification' in texts()
u.capture('../../../artifacts/harmonyos/native-chat-keyboard.png')
print('PASS: Esc blur, i focus without insertion, literal typing isolation, u/G navigation, slash search, modal Tab trap/Esc preservation, delete confirmation, Meta+Enter')
