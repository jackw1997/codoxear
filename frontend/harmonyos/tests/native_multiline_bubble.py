"""Real native width must not collapse on hard breaks or blank lines."""
import time,re
import native_ui as u
if any(n.get('id')=='Close search' for n in u.layout()):u.click('Close search')
message='Multiline '+str(time.time_ns())+'\n中文多行气泡\nThird line'
u.type_at('message-input',message,True);u.click('Send')
if any(n.get('id')=='Latest messages' for n in u.layout()):u.click('Latest messages')
for _ in range(20):
    rows=u.layout()
    texts=[n for n in rows if n.get('type')=='Text' and 'Fixture acknowledged: '+message in n.get('text','')]
    if texts:break
    time.sleep(.5)
assert texts,'Assistant multiline reply absent'
x,y,r,b=map(int,re.findall(r'\d+',texts[-1]['bounds']))
assert r-x>600,('Multiline bubble collapsed',texts[-1]['bounds'])
assert b-y<400,('Multiline bubble wraps far too narrowly',texts[-1]['bounds'])
u.capture('../../../artifacts/harmonyos/native-multiline-fixed.png')
print('PASS actual native hard-break width:',r-x,b-y)
