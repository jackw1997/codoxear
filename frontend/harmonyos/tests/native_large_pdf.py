"""Read/search the last page in a real 240-page PDF through native PDFKit."""
import time
import native_ui as u

def texts():return '\n'.join(n.get('text','') for n in u.layout() if n.get('text'))
def wait(label,seconds=25):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if label in texts():return
  time.sleep(.4)
 raise AssertionError('PDF state absent: '+label+'\n'+texts())
def rotate(angle):
 u.run('shell','hidumper','-s','DisplayManagerService','-a','-rotationlock,0')
 u.run('shell','hidumper','-s','DisplayManagerService','-a',f'-motion,{angle}');time.sleep(2)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.click('Files');u.type_at('Search files','native-large.pdf',True);u.click('Search')
start=time.monotonic();u.click('native-large.pdf');wait('1 / 240')
print('240-page document initial display in',round(time.monotonic()-start,2),'seconds')
u.click('Find in PDF');u.type_at('pdf-query','NATIVE_PDF_FINAL_TARGET',True);u.click('Find');wait('240 / 240',45)
u.capture('../../../artifacts/harmonyos/native-large-pdf-final.png')
u.click('Find in PDF');u.click('Previous page');wait('239 / 240');u.click('Next page');wait('240 / 240')
u.click('Full screen')
try:
 rotate(1);wait('240 / 240');u.capture('../../../artifacts/harmonyos/native-large-pdf-landscape.png')
finally:rotate(0)
wait('240 / 240');u.click('Exit full screen');u.click('Browse');u.type_at('Search files','two-pages.pdf',True);u.click('Search');u.click('two-pages.pdf');wait('1 / 2')
print('PASS 240-page native PDF initial load, full-document search to final page, adjacent navigation, fullscreen rotation and document switch')
