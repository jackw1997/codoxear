"""Switch the real OS display setting and inspect native app pixels.
Dedicated disposable emulator only. Restores OS light and app light.
"""
import time
from pathlib import Path
from PIL import Image
import native_ui as u

def app():
 u.run('shell','aa','start','-a','EntryAbility','-b','com.codoxear.mobile');time.sleep(1)

def system(mode):
 u.run('shell','aa','start','-a','com.huawei.hmos.settings.MainAbility','-b','com.huawei.hmos.settings');time.sleep(.8)
 if any(n.get('text')=='显示和亮度' and n.get('bounds')=='[266,1449][546,1515]' for n in u.layout()):u.click('显示和亮度')
 # Reopening Settings preserves the display page; its labels differ from app controls.
 if not any(n.get('text')=='显示模式' for n in u.layout()):u.click('显示和亮度')
 label=('深色' if mode=='dark' else '浅色')+', tab_unlock'
 u.click(label);time.sleep(1)
 assert u.node(label).get('selected')=='true', 'OS mode did not change'
 app()

def pixel(label):
 path=Path('../../../artifacts/harmonyos/native-system-'+label+'.png')
 u.capture(str(path))
 with Image.open(path) as im:
  im=im.convert('RGB');surface=im.getpixel((1250,900));bar=im.getpixel((500,40));bottom=im.getpixel((100,im.height-20))
  assert (sum(surface)<300)==(sum(bar)<300),('System bar does not match native theme',surface,bar)
  assert (sum(surface)<300)==(sum(bottom)<300),('Bottom bar does not match native theme',surface,bottom)
  return surface

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.click('Settings');u.click('system')
try:
 system('light');light=pixel('light')
 system('dark');dark=pixel('dark')
 assert sum(light)>600 and sum(dark)<300,(light,dark)
 u.click('light');override=pixel('override-light')
 assert sum(override)>600,override
 system('light');system('dark');assert sum(pixel('override-kept'))>600
 u.click('system');assert sum(pixel('system-restored'))<300
 print('PASS actual OS light/dark change updates native app; explicit light override survives OS changes:',light,dark)
finally:
 system('light');u.click('light');u.click('Close')
