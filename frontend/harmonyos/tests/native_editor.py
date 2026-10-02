"""Keyboard behavior through the installed native UI; synthetic Docker file only.
Start with Files open in the dedicated fixture session.
"""
import time
import native_ui as u

def key(*codes):
    u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.35)
def text():
    return '\n'.join(n.get('text','') for n in u.layout() if n.get('text'))
u.click('native-created.txt');u.click('Edit')
u.type_at('file-editor','alpha\nbeta\ngamma',True)
u.click('file-editor');key(2070)
assert 'NORMAL' in text()
key(2023);key(2023);key(2020);key(2020)
assert 'alpha' not in text() and 'beta' in text(),text()
key(2037)
assert 'alpha' in text(),text()
key(2072,2034)
assert 'alpha' not in text(),text()
key(2070)
assert 'Unsaved changes' in text() and 'NORMAL' in text()
u.capture('../../../artifacts/harmonyos/native-editor-normal.png')
key(2025)
assert u.node('file-editor').get('text') == 'beta\ngamma'
u.type_at('file-editor','',True);u.click('Save')
assert 'Saved' in text() and 'Unsaved' not in text()
print('PASS: native NORMAL/INSERT, gg/dd, undo/redo, dirty Esc, reactive source and reset/save')
