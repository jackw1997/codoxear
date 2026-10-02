"""Native decoder failures, disabled image actions, and file-switch recovery."""
import json,re,runpy,subprocess,time
import native_ui as u
call=runpy.run_path('/tmp/codoxear-cli-common.py')['call']
row=next(s for s in call('/api/sessions')['sessions'] if s['session_id']=='native-parity')
assert row['cwd']=='/home/tester/native-parity-fixture'
subprocess.run(['docker','--context','colima-codoxear-test','exec','-u','tester','codoxear-harmony-test','python','-c',"from pathlib import Path;p=Path('/home/tester/native-parity-fixture');(p/'native-broken-image.png').write_bytes(b'\\x89PNG\\r\\n\\x1a\\ninvalid image fixture');(p/'native-broken-video.mp4').write_bytes(b'invalid video fixture')"],check=True)
image_error='Unable to open this image. The file may be damaged or unsupported.'
video_error='Unable to play this video. The file may be damaged or use an unsupported format.'
def open_file(name):
 u.click('Browse');u.type_at('Search files',name,True);u.click('Search');u.click(name)
def wait(label,seconds=20):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if any(n.get('text')==label for n in u.layout()):return
  time.sleep(.4)
 raise AssertionError('Expected '+label)
def no_error():assert not any(n.get('text') in (image_error,video_error) for n in u.layout())
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session');u.click('Files')
u.type_at('Search files','native-broken-image.png',True);u.click('Search');u.click('native-broken-image.png');wait(image_error)
assert u.node('+')['enabled']=='false' and u.node('Fit image')['enabled']=='false'
u.run('shell','uitest','uiInput','keyEvent','2022');time.sleep(.4)
assert not {'+','−','Fit image'} & {n.get('description') for n in u.layout() if n.get('id','').startswith('hint-')}
u.run('shell','uitest','uiInput','keyEvent','2070');u.capture('../../../artifacts/harmonyos/native-image-decode-error.png')
open_file('native-chart.png');wait('100%');no_error();u.click('+');wait('150%')
u.file_tab('native-broken-image.png');wait(image_error)
open_file('native-broken-video.mp4');wait(video_error);u.capture('../../../artifacts/harmonyos/native-video-decode-error.png')
open_file('native-video.mp4');wait('00:04');no_error()
rows=u.layout();index=next(i for i,n in enumerate(rows) if n.get('type')=='Video')
play=next(n for n in rows[index+1:] if n.get('type')=='Image');u.run('shell','uitest','uiInput','click',*u.center(play));time.sleep(1.5)
rows=u.layout();index=next(i for i,n in enumerate(rows) if n.get('type')=='Video')
labels=[n.get('text','') for n in rows[index+1:] if re.fullmatch(r'\d\d:\d\d',n.get('text',''))]
assert len(labels)==2 and labels[0]!='00:00',labels
u.file_tab('native-broken-video.mp4');wait(video_error)
print('PASS native damaged image/video errors; image zoom/fit disabled and excluded from hints; valid file switches clear error and restore zoom/playback; broken tabs retain error')
