"""Search inline/display TeX through the real native UI on a dedicated fixture."""
import time,re
from pathlib import Path
from PIL import Image
import native_ui as u
ART=Path('../../../artifacts/harmonyos')
def colored(path,color):
 im=Image.open(path).convert('RGB');rgb=tuple(bytes.fromhex(color.lstrip('#')))
 # Exclude the composer and top search controls; inspect the transcript.
 return sum(max(abs(a-b) for a,b in zip(p,rgb))<4 for p in im.crop((0,450,im.width,im.height-500)).getdata())
def shot(name):
 p=ART/(name+'.png');u.capture(str(p));return p
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')

if not any(n.get('id')=='chat-keyboard' and n.get('text')=='Math search verification' for n in u.layout()):u.select_session('Math search verification')
number=str(time.time_ns())[-7:];message='Math highlight verification '+str(time.time_ns())+'\n\nInline $\\frac{713}{997}$ and untouched $x^2$.\n\n$$\\sqrt{713}+y^2$$'
message=message.replace('713',number)
u.type_at('message-input',message,True);u.click('Send');time.sleep(1)
for family,mode,color in [('slate','dark','#6b5a1e'),('clay','light','#f5dfa0')]:
 u.click('Sessions');u.click('Settings');u.click(family);u.click(mode);u.click('Close')
 if any(n.get('id')=='Settings' for n in u.layout()):u.select_session('Math search verification')
 baseline=colored(shot('math-search-'+mode+'-before'),color)
 u.click('Search conversation');u.type_at('Search conversation',number,True);u.click('Search');u.node('2 matches')
 rows=u.layout();hit=next(n for n in rows if number in n.get('text','') and '\\frac' in n.get('text','') and n.get('type')=='Text')
 u.run('shell','uitest','uiInput','click',*u.center(hit));time.sleep(.7);u.node('message-input')
 highlighted=shot('math-search-'+mode)
 assert colored(highlighted,color)>baseline+200, (mode,'Formula highlight is not visible')
 u.click('Close search');time.sleep(.5)
 cleared=shot('math-search-'+mode+'-cleared')
 assert colored(cleared,color)<100,(mode,'Clearing search leaves a stale highlight')
 print('PASS',family,mode,'inline/display math search and clear',flush=True)
