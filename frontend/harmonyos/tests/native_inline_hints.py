"""Activate a shaped, wrapped Unicode Markdown link through native keyboard hints."""
import time,re
import native_ui as u

def key(*codes):
    u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def badges():return [n for n in u.layout() if n.get('id','').startswith('hint-')]

def run():
    u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
    label='定位文件：中文与 emoji 🐟，这是一条需要换行的原生链接'
    message='🔎 前缀与公式 $x^2$ ['+label+'](native-line-target.py:40)'
    u.type_at('message-input',message,True);u.click('Send');time.sleep(2)
    if any(n.get('id')=='Latest messages' for n in u.layout()):u.click('Latest messages')
    u.click('message-input');key(2070);key(2022)
    rows=badges()
    matches=[n for n in rows if label in n.get('description','')]
    assert matches, ('No native link hint',rows)
    # A badge starts on an actually rendered text range within the transcript.
    link=matches[-1];x,y=map(int,re.findall(r'\d+',link['bounds'])[:2])
    texts=[n for n in u.layout() if label in n.get('text','') and n.get('type')=='Text']
    assert any(l<=x<r and t<=y<b for l,t,r,b in [list(map(int,re.findall(r'\d+',n['bounds']))) for n in texts]),(link,texts)
    u.capture('../../../artifacts/harmonyos/native-inline-link-hints.png')
    for c in link['text']:key(2017+ord(c)-97 if c.isalpha() else 2000+int(c))
    u.node('value_40 = 40');assert not badges()
    assert not any(n.get('text')=='value_1 = 1' for n in u.layout())
    print('PASS: Unicode/emoji/math preceding wrapped Markdown link has native range hint and opens source line 40')

if __name__=='__main__':run()
