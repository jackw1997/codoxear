"""Exercise a tap outside compact controls' visible bounds on the slab emulator."""
import re,time
import native_ui as u

def outside(label):
 x,y,r,b=map(int,re.findall(r'\d+',u.node(label)['bounds']))
 # 4vp past the visible bottom, inside its added 6vp response region.
 u.run('shell','uitest','uiInput','click',str((x+r)//2),str(b+14));time.sleep(.7)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
outside('Files');assert u.node('Search files')
u.type_at('Search files','two-pages.pdf',True);u.click('Search');u.click('two-pages.pdf');time.sleep(1)
outside('Next page');assert u.node('2 / 2')
outside('Previous page');assert u.node('1 / 2')
outside('Full screen');assert u.node('Exit full screen')
outside('Exit full screen');assert u.node('Full screen')
print('PASS taps 4vp outside visible compact icon/PDF buttons activate the intended actions')
