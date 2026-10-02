"""Pinch, pan and double-tap through the native touch input service."""
import time,re
from pathlib import Path
import native_ui as u

def zoom():
    values=[int(n['text'][:-1]) for n in u.layout() if re.fullmatch(r'\d+%',n.get('text',''))]
    assert len(values)==1,values
    return values[0]
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session');u.click('Files')
u.type_at('Search files','native-chart.png',True);u.click('Search');u.click('native-chart.png');u.click('Full screen')
assert zoom()==100
x,y,r,b=map(int,re.findall(r'\d+',u.node('image-viewport')['bounds']));cx=(x+r)//2;cy=(y+b)//2
assert b-y>1400, ('Image viewport collapsed behind toolbar',x,y,r,b)
u.run('shell','uinput','-T','-m',str(cx-100),str(cy),str(cx-350),str(cy),str(cx+100),str(cy),str(cx+350),str(cy),'1000');time.sleep(1)
assert zoom()>200,zoom()
u.capture('../../../artifacts/harmonyos/native-image-pinched.png')
u.run('shell','uitest','uiInput','swipe',str(cx),str(cy),str(cx+260),str(cy),'700');time.sleep(.5)
u.capture('../../../artifacts/harmonyos/native-image-panned.png')
# Observe actual rendered colored pixels, not internal state.
from PIL import Image

def blue_centroid(path):
    image=Image.open(path).convert('RGB');coords=[]
    for py in range(y,min(b,image.height),4):
        for px in range(x,min(r,image.width),4):
            red,green,blue=image.getpixel((px,py))
            if blue>red+20 and blue>green+10 and 70<red<160:coords.append(px)
    assert coords,'No blue chart bar rendered'
    return sum(coords)/len(coords)
base=Path('../../../artifacts/harmonyos')
a=blue_centroid(base/'native-image-pinched.png');c=blue_centroid(base/'native-image-panned.png')
assert abs(c-a)>20,(a,c)
u.run('shell','uitest','uiInput','doubleClick',str(cx),str(cy));time.sleep(.5)
assert zoom()==100
u.capture('../../../artifacts/harmonyos/native-image-fit-gesture.png')
print('PASS: native two-finger pinch, visible pan displacement and double-tap fit reset',a,c)
