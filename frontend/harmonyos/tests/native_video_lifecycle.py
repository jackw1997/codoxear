"""Native AV video controls, rotation and source replacement, Docker media."""
import time,re
import native_ui as u

def controls():
 rows=u.layout();index=next(i for i,n in enumerate(rows) if n.get('type')=='Video')
 # Native Video exposes its controls as descendants in pre-order.
 return rows[index+1:next((i for i in range(index+1,len(rows)) if rows[i].get('type')=='WindowScene'),len(rows))]
def seconds():
 labels=[n['text'] for n in controls() if re.fullmatch(r'\d\d:\d\d',n.get('text',''))]
 assert len(labels)==2,labels
 return int(labels[0][:2])*60+int(labels[0][3:]),labels[1]
def toggle():
 image=next(n for n in controls() if n.get('type')=='Image');u.run('shell','uitest','uiInput','click',*u.center(image));time.sleep(.5)
def rotate(angle):
 u.run('shell','hidumper','-s','DisplayManagerService','-a','-rotationlock,0');u.run('shell','hidumper','-s','DisplayManagerService','-a',f'-motion,{angle}');time.sleep(2)

def open_file(name):
 u.click('Browse');u.type_at('Search files',name,True);u.click('Search');u.click(name);time.sleep(1)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.click('Files');u.type_at('Search files','native-video-long.mp4',True);u.click('Search');u.click('native-video-long.mp4');time.sleep(1)
assert seconds()==(0,'00:30'),seconds()
toggle();time.sleep(3);toggle();position,duration=seconds();assert position>=3,(position,duration)
u.click('Full screen');assert seconds()[0]==position
try:
 rotate(1);assert seconds()[0]==position,(position,seconds());u.capture('../../../artifacts/harmonyos/native-video-landscape.png')
 toggle();time.sleep(2);toggle();assert seconds()[0]>position
finally:rotate(0)
u.click('Exit full screen');position=seconds()[0]
u.run('shell','uitest','uiInput','keyEvent','Home');time.sleep(2);u.run('shell','aa','start','-a','EntryAbility','-b','com.codoxear.mobile');time.sleep(1)
assert seconds()[0]==position,(position,seconds())
open_file('native-video.mp4');assert seconds()==(0,'00:04'),seconds()
u.capture('../../../artifacts/harmonyos/native-video-switched.png')
print('PASS video play/pause, fullscreen rotation preserves position, resume playback, background paused state and replacement source')
