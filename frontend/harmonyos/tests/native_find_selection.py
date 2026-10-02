"""Select a search match, delete precisely that range, then undo in native UI."""
import time
import native_ui as u
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
for _ in range(8):
    if any(n.get('text')=='Native verified session' for n in u.layout()):break
    u.run('shell','uitest','uiInput','swipe','650','2350','650','900','500')
u.click('Native verified session');u.click('Files');u.type_at('Search files','native-line-target.py',True);u.click('Search');u.click('native-line-target.py');u.click('Edit')
base=u.node('file-editor')['text'];assert base.count('value_40')==1
u.click('Find');u.type_at('file-find','value_40',True);u.click('Next');time.sleep(.5)
u.run('shell','uitest','uiInput','keyEvent','2055');time.sleep(.8)
actual=u.node('file-editor')['text']
assert actual==base.replace('value_40',''),(actual[500:700],base[500:700])
u.run('shell','uitest','uiInput','keyEvent','Back');u.click('Undo')
assert u.node('file-editor')['text']==base
print('PASS native Find Next selects exact match; Backspace deletes match and Undo restores')
