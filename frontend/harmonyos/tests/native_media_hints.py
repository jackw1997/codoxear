"""Use physical key events to operate native image/PDF controls and fields."""
import re,time
import native_ui as u

def key(*codes):
    u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.35)
def badges():return [n for n in u.layout() if n.get('id','').startswith('hint-')]
def activate(label):
    key(2022)
    rows=badges()
    assert not {'Send','New session','Message','Sessions'} & {n.get('description') for n in rows},rows
    matches=[n for n in rows if n.get('description')==label]
    assert len(matches)==1,(label,rows)
    for c in matches[0]['text']:key(2017+ord(c)-97 if c.isalpha() else 2000+int(c))
def wait(label,timeout=25):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if any(n.get('text')==label for n in u.layout()):return
        time.sleep(.3)
    raise AssertionError('Missing '+label)
def open_file(name):
    u.click('Browse');u.type_at('Search files',name,True);u.click('Search');u.click(name)
def leave_field():
    key(2070)
    for _ in range(12):
        key(2049)
        if not any(n.get('focused')=='true' and n.get('type') in ('TextInput','TextArea') for n in u.layout()):return
    raise AssertionError('Unable to leave field')
def field_width(label):
    x,y,r,b=map(int,re.findall(r'\d+',u.node(label)['bounds']))
    assert r-x>180 and b-y>60,(label,x,y,r,b)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session');u.click('Files')
u.type_at('Search files','native-chart.png',True);u.click('Search');u.click('native-chart.png');wait('100%')
activate('+');wait('150%');activate('−');wait('100%');activate('+');activate('Fit image');wait('100%')
key(2022);assert {'+','−','Fit image'} <= {n.get('description') for n in badges()}
u.capture('../../../artifacts/harmonyos/native-image-hints.png');key(2070)
open_file('native-encrypted.pdf');wait('This PDF requires a password.')
activate('PDF password');assert u.node('pdf-password')['focused']=='true';field_width('pdf-password')
key(2022);assert not badges() # literal f belongs to password field
u.run('shell','uitest','uiInput','keyEvent','2072','2017');u.run('shell','uitest','uiInput','text','native-pdf-test');leave_field()
activate('Unlock PDF');wait('1 / 2');activate('Next page');wait('2 / 2')
open_file('native-large.pdf');wait('1 / 240');activate('Find in PDF');activate('Search PDF')
assert u.node('pdf-query')['focused']=='true';field_width('pdf-query')
key(2022);assert u.node('pdf-query')['text']=='f';assert not badges()
u.run('shell','uitest','uiInput','keyEvent','2072','2017');u.run('shell','uitest','uiInput','text','NATIVE_PDF_FINAL_TARGET');leave_field()
activate('Find');wait('240 / 240',45)
key(2022);assert {'Search PDF','Find','Next'} <= {n.get('description') for n in badges()}
u.capture('../../../artifacts/harmonyos/native-pdf-search-hints.png');key(2070)
print('PASS scoped image zoom/fit hints; encrypted PDF password focus, literal f, unlock/navigation; PDF search focus, literal f, search to final page')
