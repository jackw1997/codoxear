"""Verify variable padding through actual ArkUI geometry, then restore CSS."""
import re,time
import native_ui as u
marker='PAD'+str(time.time_ns())[-4:]
def rect(n):return tuple(map(int,re.findall(r'\d+',n['bounds'])))
def bubble():
 rows=u.layout();target=next(n for n in rows if n.get('type')=='Text' and n.get('text')==marker);tx,ty,tr,tb=rect(target)
 choices=[rect(n) for n in rows if n.get('type')=='Stack' and rect(n)[0]<=tx and rect(n)[1]<=ty and rect(n)[2]>=tr and rect(n)[3]>=tb]
 assert choices,'Message container absent'
 x,y,r,b=min(choices,key=lambda a:(a[2]-a[0])*(a[3]-a[1]))
 return r-x,b-y

def css(value):
 u.click('Sessions');u.click('Settings');u.type_at('custom-css',value,True)
 assert not any('Unsupported padding' in n.get('text','') for n in u.layout())
 u.click('Close');time.sleep(.8)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.type_at('message-input',marker,True);u.click('Send');time.sleep(2)
try:
 css(':root { --native-pad: 5px; } .msg { padding:var(--native-pad); }')
 small=bubble()
 css(':root { --native-pad: 35px; } .msg { padding:var(--native-pad); }')
 large=bubble();assert 207<=large[1]-small[1]<=213,(small,large)
 assert 207<=large[0]-small[0]<=213,(small,large)
 u.capture('../../../artifacts/harmonyos/native-css-variable-padding.png')
 print('PASS native variable padding from 5vp to 35vp changes both bubble dimensions by 60vp:',small,large)
finally:css('')
