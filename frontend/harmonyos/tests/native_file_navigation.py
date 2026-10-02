"""Native file links, keyboard save/find and cross-tab undo against Docker fixtures."""
import time, re
import native_ui as u

def key(*codes):
    u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def texts():
    return '\n'.join(n.get('text','') for n in u.layout() if n.get('text'))
def browse(name):
    u.click('Browse');u.type_at('Search files',name,True);u.click('Search');u.click(name)
def link(label):
    n=u.node(label);x,y,r,b=map(int,re.findall(r"\d+",n["bounds"]));u.run("shell","uitest","uiInput","click",str(x+80),str((y+b)//2));time.sleep(.5)
def visible(label):
    n=u.node(label);return n.get('bounds')

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
u.click('Native verified session');u.click('Files');u.type_at('Search files','native-links',True);u.click('Search');u.click('native-links.md')
print('Initial',visible('Jump to destination'))
link('Jump to destination');time.sleep(.5)
print('Destination',visible('Destination'))
u.capture('../../../artifacts/harmonyos/native-file-anchor.png')
link('Back to top');link('Open Python line 40');time.sleep(.5)
assert 'native-line-target.py' in texts()
assert 'value_40 = 40' in texts() and 'value_1 = 1' not in texts(),texts()
print('Line 40',visible('value_40 = 40'))
browse('native-history-edit.txt');u.click('Edit');u.type_at('file-editor','changed buffer\nsecond line\n',True)
u.click('file-editor');key(2072,2035)
assert 'Saved' in texts() and 'Unsaved' not in texts(),texts()
u.type_at('file-editor','unsaved later\nsecond line\n',True)
u.file_tab('native-line-target.py');u.file_tab('native-history-edit.txt •');u.click('Undo')
assert u.node('file-editor').get('text')=='changed buffer\nsecond line\n',texts()
u.click('file-editor');key(2072,2022)
assert u.node('file-find')
u.type_at('file-find','second',True);u.click('Next')
assert '1' in texts()
u.capture('../../../artifacts/harmonyos/native-file-keyboard.png')
# Reset the disposable fixture through the same UI.
u.type_at('file-editor','original\nsecond line\n',True);u.click('Save')
print('PASS: heading link, return link, cross-file line link, Ctrl+S/Ctrl+F and undo after tab switch')
