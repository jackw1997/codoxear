"""Real editor view-state continuity across different native file components."""
import time
import native_ui as u

def key(*codes):
    u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def texts():return '\n'.join(n.get('text','') for n in u.layout() if n.get('text'))
def browse(name):
    u.click('Browse');u.type_at('Search files',name,True);u.click('Search');u.click(name)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
u.select_session('Native verified session');u.click('Files');u.type_at('Search files','native-line-target.py',True);u.click('Search');u.click('native-line-target.py')
u.click('Find');u.type_at('file-find','value_40',True);u.click('Next')
assert 'value_40 = 40' in texts() and 'value_1 = 1' not in texts(),texts()
browse('native-history-edit.txt');u.file_tab('native-line-target.py');time.sleep(.4)
assert u.node('file-find')['text']=='value_40'
assert 'value_40 = 40' in texts() and 'value_1 = 1' not in texts(),texts()
u.capture('../../../artifacts/harmonyos/native-file-view-restored.png')
# Preserve an editing mode/caret across tabs without changing the server file.
u.click('file-find');key(2070);u.click('Edit');u.click('file-editor');key(2070)
u.click('file-keyboard');key(2047,2023)
u.file_tab('native-history-edit.txt');u.file_tab('native-line-target.py')
assert 'NORMAL' in texts(),texts()
u.click('file-keyboard');key(2025)
u.run('shell','uitest','uiInput','text','CARET_CHECK');key(2070)
u.click('file-keyboard');key(2025)
value=u.node('file-editor')['text']
assert 'CARET_CHECK' in value and value.index('CARET_CHECK') > len(value)//2,value[:200]
u.run('shell','uitest','uiInput','keyEvent','Back');u.click('Undo')
assert 'CARET_CHECK' not in u.node('file-editor')['text']
assert 'Unsaved' not in texts()
print('PASS: find query, source scroll, NORMAL mode and caret survive tab switches; undo restores the clean file')
