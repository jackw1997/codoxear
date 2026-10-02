"""Native PDF errors, password retry and document lifecycle on Docker fixtures."""
import time
import native_ui as u

def wait(label):
 end=time.monotonic()+20
 while time.monotonic()<end:
  if any(n.get('text')==label for n in u.layout()):return
  time.sleep(.3)
 raise AssertionError(label)
def open_file(name):
 u.click('Browse');u.type_at('Search files',name,True);u.click('Search');u.click(name)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.click('Files');u.type_at('Search files','native-corrupt.pdf',True);u.click('Search');u.click('native-corrupt.pdf')
wait('Unable to open this PDF. The file may be damaged or unsupported.')
assert u.node('Find in PDF').get('enabled')=='false'
u.capture('../../../artifacts/harmonyos/native-pdf-corrupt.png')
open_file('native-encrypted.pdf');wait('This PDF requires a password.')
assert u.node('Unlock PDF').get('enabled')=='false'
u.type_at('pdf-password','incorrect-test',True);u.click('Unlock PDF');wait('Incorrect PDF password. Try again.')
assert u.node('pdf-password').get('text')==''
u.capture('../../../artifacts/harmonyos/native-pdf-password.png')
u.type_at('pdf-password','native-pdf-test',True);u.click('Unlock PDF');wait('1 / 2')
assert not any(n.get('id')=='pdf-password' for n in u.layout())
u.click('Next page');wait('2 / 2');u.capture('../../../artifacts/harmonyos/native-pdf-unlocked.png')
open_file('two-pages.pdf');wait('1 / 2');u.file_tab('native-encrypted.pdf');wait('This PDF requires a password.')
assert u.node('pdf-password').get('text')==''
u.file_tab('two-pages.pdf');wait('1 / 2')
print('PASS corrupt PDF visible error, disabled controls, encrypted password prompt, wrong password retry, successful unlock, document switch and no retained password')
