"""System Documents export: actual native picker and source/download SHA-256."""
import hashlib,subprocess,time
from pathlib import Path
import native_ui as u

def verify(name):
    target=Path('/tmp/codoxear-native-export-'+name)
    u.run('file','recv','/storage/media/100/local/files/Docs/Documents/'+name,str(target))
    source=subprocess.run(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','sha256sum','/home/tester/native-parity-fixture/'+name],capture_output=True,text=True,check=True).stdout.split()[0]
    actual=hashlib.sha256(target.read_bytes()).hexdigest()
    assert actual==source,(name,actual,source)
    print(name,target.stat().st_size,actual)
# PNG was just exported through Download -> native dialog_confirm.
verify('native-chart.png')
for name in ['two-pages.pdf','native-video.mp4']:
    u.click('Browse');u.type_at('Search files',name,True);u.click('Search');u.click(name);time.sleep(.6)
    u.click('Download');u.click('dialog_confirm');time.sleep(2)
    verify(name)
print('PASS: PNG, PDF and MP4 native Documents export matches source bytes')
