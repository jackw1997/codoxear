"""Real six-theme native screenshots and primary/normal icon contrast pixels."""
import re
from pathlib import Path
from PIL import Image
import native_ui as u
cases=[('clay','light','#fffdf9','#b35739','#35302a'),('clay','dark','#2b2118','#d97757','#ece4d5'),('paper','light','#ffffff','#2f2b26','#2f2b26'),('paper','dark','#211e19','#e6e1d7','#e6e1d7'),('slate','light','#ffffff','#0d0d0d','#0d0d0d'),('slate','dark','#2f2f2f','#ececec','#ececec')]
def rgb(v):return tuple(int(v[i:i+2],16) for i in (1,3,5))
def count(im,box,color):return sum(max(abs(a-b) for a,b in zip(pixel,rgb(color)))<=2 for pixel in im.crop(box).getdata())
def bounds(label):return tuple(map(int,re.findall(r'\d+',u.node(label)['bounds'])))
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
for family,mode,on_primary,primary,ink in cases:
 u.click('Settings');u.click(family);u.click(mode);u.click('Close');u.click('Sessions')
 u.select_session('Native verified session')
 assert not any(n.get('id')=='Settings' for n in u.layout()),'Session selection did not close the sidebar'
 send=bounds('Send');files=bounds('Files')
 path=Path('../../../artifacts/harmonyos/native-theme-'+family+'-'+mode+'.png');u.capture(str(path))
 with Image.open(path) as source:
  im=source.convert('RGB')
  # The send icon is centered, so the paper surrounding the button cannot
  # satisfy its contrasting-ink assertion in dark modes.
  x,y,r,b=send;icon=(x+24,y+24,r-24,b-24)
  assert 70<count(im,icon,on_primary)<1500,(family,mode,'primary icon is unreadable',count(im,icon,on_primary))
  # SVG point (10,9) is inside the paper-plane outline, away from strokes.
  assert max(abs(a-b) for a,b in zip(im.getpixel((x+51,y+48)),rgb(primary)))<=3,(family,mode,'outline icon was filled')
  assert count(im,send,primary)>2000,(family,mode,'wrong primary fill')
  assert count(im,files,ink)>70,(family,mode,'normal icon ignores theme')
  # This fixture contains only prose and links in the visible conversation.
  # No theme uses black here: default-black native underline paint is a bug.
  assert count(im,(30,550,1290,2450),'#000000')<10,(family,mode,'link decorations ignore theme')
 u.click('Sessions')
 u.capture('../../../artifacts/harmonyos/native-theme-'+family+'-'+mode+'-sessions.png')
 print('PASS theme chrome:',family,mode,flush=True)
u.click('Settings');u.click('clay');u.click('light');u.click('Close')
print('PASS all six native themes retain contrasting icon ink; restored Clay Light')
