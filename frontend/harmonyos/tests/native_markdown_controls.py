"""Markdown code/image and preview links use native scoped keyboard controls."""
import time
import native_ui as u

def key(*codes):u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def hints():return [n for n in u.layout() if n.get('id','').startswith('hint-')]
def activate(label):
    key(2022)
    matches=[n for n in hints() if n.get('description')==label]
    assert matches, (label,hints())
    for c in matches[-1]['text']:key(2017+ord(c)-97 if c.isalpha() else 2000+int(c))

def open_file(name):
    u.type_at('Search files',name,True);u.click('Search');u.click(name)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
code='NATIVE_HINT_COPY = "中文 🐟"'
u.type_at('message-input','\n\n```python\n'+code+'\n```\n\n![Native hint image](native-chart.png)',True);u.click('Send');time.sleep(2)
if any(n.get('id')=='Latest messages' for n in u.layout()):u.click('Latest messages')
u.click('message-input');key(2070)
blocks=[n for n in u.layout() if n.get('id')=='markdown-code' and code in n.get('text','')]
assert blocks, 'Rendered code is missing'
u.run('shell','uitest','uiInput','click',*u.center(blocks[-1]));time.sleep(.4)
activate('Copy code')
u.click('message-input');key(2072,2038);assert u.node('message-input')['text'].strip()==code
u.type_at('message-input','',True);u.click('message-input');key(2070)
activate('Native hint image');u.node('100%');u.node('native-chart.png');u.click('Close')
u.click('Files');open_file('native-links.md');u.node('Jump to destination')
activate('Source');u.node('Preview');activate('Preview');u.node('Jump to destination')
activate('Jump to destination');u.node('Destination');activate('Back to top');u.node('Open Python line 40')
activate('Open Python line 40');u.node('value_40 = 40');assert not hints()
print('PASS: hinted Markdown Copy with exact Unicode clipboard, image preview, heading/back links and file line link in modal scope')
