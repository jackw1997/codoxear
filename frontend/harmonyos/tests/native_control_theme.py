"""Exercise app-owned dropdowns and popup paint across the six app themes.
Run only on a dedicated emulator with CODOXEAR_HDC_TARGET set.
No session is created and no conversation setting is modified.
"""
import os,re,time
from pathlib import Path
from PIL import Image
import native_ui as u
CASES=[('slate','dark','#e9e9e9','#a0a0a0','#2f2f2f'),('clay','dark','#e9e1d2','#a29785','#26211b'),('paper','dark','#e6e1d7','#9d978a','#211e19'),('slate','light','#0d0d0d','#6e6e6e','#ffffff'),('clay','light','#322d27','#8a7f6f','#fffdf9'),('paper','light','#2f2b26','#6b6862','#ffffff')]
def bounds(n):return tuple(map(int,re.findall(r'\d+',n['bounds'])))
def reveal(label):
 for _ in range(8):
  rows=u.layout();n=next((n for n in rows if n.get('id')==label),None)
  if n:
   x,y,r,b=bounds(n)
   if 365<y<b<2600:return n
  u.run('shell','uitest','uiInput','swipe','1150','2300','1150','1500','400');time.sleep(.25)
 raise AssertionError('Control not visible: '+label)
def count(im,box,color):
 rgb=tuple(int(color[i:i+2],16) for i in (1,3,5))
 return sum(max(abs(a-b) for a,b in zip(p,rgb))<=3 for p in im.crop(box).getdata())
def shot(name):
 p=Path('../../../artifacts/harmonyos/'+name+'.png');u.capture(str(p));return Image.open(p).convert('RGB')
# Caller starts authenticated with a visible sidebar.
for family,mode,text,muted,paper in CASES:
 if os.environ.get('CODOXEAR_THEME_CASES') and family+'-'+mode not in os.environ['CODOXEAR_THEME_CASES'].split(','):continue
 if not any(n.get('id')=='Settings' for n in u.layout()):u.click('Sessions')
 u.click('Settings');u.click(family);u.click(mode);u.click('Close');u.click('New session');u.click('Codex')
 u.type_at('Working directory','/home/tester/native-parity-fixture',True);time.sleep(1)
 for ident in ['launch-provider','launch-model','launch-effort','launch-resume']:
  n=reveal(ident);im=shot('controls-'+family+'-'+mode+'-'+ident);x,y,r,b=bounds(n)
  assert count(im,(x+15,y+8,r-100,b-8),text)>100,(family,mode,ident,'unreadable label')
  assert count(im,(r-110,y,r,b),muted)>20,(family,mode,ident,'unreadable arrow')
  assert count(im,(x+10,y+5,r-10,b-5),paper)>1000,(family,mode,ident,'wrong surface')
  if ident=='launch-effort':
   u.click(ident);im=shot('controls-'+family+'-'+mode+'-menu')
   option=u.node('minimal');box=bounds(option)
   assert count(im,box,text)>60,(family,mode,'popup text ignores theme')
   u.click('medium');u.node('medium')
   assert not any(n.get('id')==ident+'-menu' for n in u.layout()), 'Menu must close after selection'
 u.click('Close')
 print('PASS native form controls and expanded menu',family,mode,flush=True)
if not any(n.get('id')=='Settings' for n in u.layout()):u.click('Sessions')
u.click('Settings');u.click('slate');u.click('dark');u.click('Close');u.click('New session');u.click('Codex');reveal('launch-provider')
u.capture('../../../artifacts/harmonyos/slate-dark-select-after.png')
print('PASS requested theme cases: dropdown contrast, popup and selection; no sessions created',flush=True)
