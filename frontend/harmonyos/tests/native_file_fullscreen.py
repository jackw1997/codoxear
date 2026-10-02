"""Native media and editor fullscreen, rotation, and PDF switching."""
import time
import native_ui as u

def texts():return '\n'.join(n.get('text','') for n in u.layout() if n.get('text'))
def open_file(name):
    u.click('Browse');u.type_at('Search files',name,True);u.click('Search');u.click(name)
def rotate(angle):
    u.run('shell','hidumper','-s','DisplayManagerService','-a','-rotationlock,0')
    u.run('shell','hidumper','-s','DisplayManagerService','-a',f'-motion,{angle}');time.sleep(2)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
u.click('Native verified session');u.click('Files');u.type_at('Search files','two-pages.pdf',True);u.click('Search');u.click('two-pages.pdf');time.sleep(1)
assert '1 / 2' in texts(),texts()
u.click('Full screen');assert 'Browse' not in texts()
u.click('Next page');assert '2 / 2' in texts()
u.capture('../../../artifacts/harmonyos/native-pdf-fullscreen.png')
rotate(1)
assert '2 / 2' in texts(),texts()
u.capture('../../../artifacts/harmonyos/native-pdf-landscape.png')
rotate(0);u.click('Exit full screen');open_file('native-preview.pdf');time.sleep(1)
assert '1 / 1' in texts(),texts()
u.click('two-pages.pdf');time.sleep(1);assert '1 / 2' in texts(),texts()
open_file('native-chart.png');u.click('Full screen');u.click('+');assert '150%' in texts()
u.capture('../../../artifacts/harmonyos/native-image-fullscreen.png')
u.click('Exit full screen');open_file('native-history-edit.txt');u.click('Edit');u.type_at('file-editor','Fullscreen rotation draft\n中文 keeps its place',True)
u.click('Full screen');rotate(1)
assert u.node('file-editor').get('text')=='Fullscreen rotation draft\n中文 keeps its place'
u.capture('../../../artifacts/harmonyos/native-editor-landscape.png')
rotate(0);u.click('Exit full screen');u.type_at('file-editor','original\nsecond line\n',True);u.click('Save')
print('PASS: native PDF fullscreen/rotation/page continuity, cross-PDF reload, image fullscreen/zoom, editor draft through rotation')
