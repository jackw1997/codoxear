"""Native editor and PDF controls activate through actual keyboard hints."""
import time,re
import native_ui as u

def key(*codes):u.run('shell','uitest','uiInput','keyEvent',*[str(c) for c in codes]);time.sleep(.4)
def badges():return [n for n in u.layout() if n.get('id','').startswith('hint-')]
def activate(label):
 target=u.node(label);x,y=map(int,re.findall(r'\d+',target['bounds'])[:2]);key(2022)
 rows=badges();assert rows, 'No hints for '+label
 row=min(rows,key=lambda n:sum((a-b)**2 for a,b in zip(map(int,re.findall(r'\d+',n['bounds'])[:2]),[x,y])))
 assert abs(int(re.findall(r'\d+',row['bounds'])[0])-x)<5,(label,row)
 for c in row['text']:key(2017+ord(c)-97 if c.isalpha() else 2000+int(c))

def find_file(name):
 u.type_at('Search files',name,True);u.click('Search');u.click(name)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Native verified session')
u.click('Files');find_file('native-history-edit.txt');u.click('file-keyboard')
activate('Find');u.node('file-find');u.click('file-find');u.run('shell','uitest','uiInput','text','f');assert not badges();assert u.node('file-find')['text']=='f'
key(2070);u.click('file-keyboard');activate('Edit');u.node('file-editor')
u.click('file-editor');key(2070);u.node('NORMAL');activate('Find');u.node('file-find');key(2070)
u.click('Browse');find_file('two-pages.pdf');time.sleep(1)
activate('Next page');assert u.node('2 / 2');assert not badges()
key(2022);u.capture('../../../artifacts/harmonyos/native-keyboard-hints-pdf.png');key(2055);assert not badges();u.node('2 / 2')
print('PASS: native editor hinted Find/Edit, literal f in Find, NORMAL hint precedence, PDF hinted Next page and Backspace cancellation')
