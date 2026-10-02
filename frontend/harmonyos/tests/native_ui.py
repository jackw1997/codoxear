"""Real emulator UI interaction helper. Uses hdc/uitest, never injects app state."""
import argparse, json, os, re, shlex, subprocess, time
from pathlib import Path
HDC = '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc'
def run(*args):
    if args and args[0] == 'shell':
        args = ('shell', shlex.join(args[1:]))
    target = os.environ.get('CODOXEAR_HDC_TARGET', '127.0.0.1:15557')
    result = subprocess.run([HDC, '-t', target, *args], check=True, capture_output=True, text=True, timeout=30)
    if 'Error:' in result.stdout or 'error:' in result.stdout:
        raise RuntimeError(result.stdout)
    return result.stdout

def layout():
    remote = f'/data/local/tmp/codoxear-layout-{time.time_ns()}.json'
    local = Path('/tmp') / Path(remote).name
    local.unlink(missing_ok=True)
    run('shell', 'uitest', 'dumpLayout', '-p', remote)
    run('file', 'recv', remote, str(local))
    run('shell', 'rm', remote)
    nodes = []
    def visit(node):
        nodes.append(node.get('attributes', {}))
        for child in node.get('children', []): visit(child)
    visit(json.loads(local.read_text()))
    local.unlink(missing_ok=True)
    return nodes

def node(label):
    # Native layout can briefly be absent while an IME transition or a large
    # buffer is committed. Wait for an actual visible control, never stale data.
    deadline=time.monotonic()+8
    while True:
        rows=layout()
        matches=[a for a in rows if a.get('id') == label] or [a for a in rows if a.get('text') == label and a.get('type') == 'Button'] or [a for a in rows if a.get('text') == label and a.get('type') not in ('TextInput','TextArea')] or [a for a in rows if a.get('text') == label]
        if matches:return matches[0]
        if time.monotonic()>=deadline:raise AssertionError(f'No visible UI element: {label}')
        time.sleep(.25)

def center(a):
    x,y,r,b=map(int,re.findall(r'\d+',a['bounds']))
    return str((x+r)//2),str((y+b)//2)

def click(label):
    run('shell','uitest','uiInput','click',*center(node(label)));time.sleep(.6)

def file_tab(label):
    # Compact tabs scroll horizontally on phones. Find the actual visible tab,
    # including partial clipping, instead of tapping an off-screen coordinate.
    for direction in (1, -1):
        for _ in range(8):
            rows=layout();tabs=next(n for n in rows if n.get('id')=='file-tabs')
            left,top,right,bottom=map(int,re.findall(r'\d+',tabs['bounds']))
            matches=[n for n in rows if n.get('type')=='Button' and n.get('text')==label]
            for n in matches:
                x,y,r,b=map(int,re.findall(r'\d+',n['bounds']))
                x=max(x,left);r=min(r,right)
                if r-x>12:
                    run('shell','uitest','uiInput','click',str((x+r)//2),str((max(y,top)+min(b,bottom))//2));time.sleep(.6)
                    return
            start=right-12 if direction==1 else left+12
            stop=left+12 if direction==1 else right-12
            run('shell','uitest','uiInput','swipe',str(start),str((top+bottom)//2),str(stop),str((top+bottom)//2),'400')
    raise AssertionError('Open file tab not found: '+label)

def select_session(label):
    # The catalog grows during real launch tests; old fixtures can scroll below
    # the viewport. Scroll the actual sidebar rather than touching app state.
    for _ in range(12):
        matches=[n for n in layout() if n.get('text') == label and n.get('id') != 'chat-keyboard']
        if matches:
            run('shell','uitest','uiInput','click',*center(matches[0]));time.sleep(.6)
            return
        run('shell','uitest','uiInput','swipe','650','2350','650','900','500')
        time.sleep(.3)
    raise AssertionError('Session not found in catalog: '+label)

def initialize_keyboard():
    # Only on dedicated disposable emulators: finish the native IME's first-run UI.
    for attempt in range(8):
        texts={n.get('text') for n in layout()}
        if '同意' in texts:click('同意')
        elif '下一步' in texts:
            if '26 键' in texts:click('26 键')
            click('下一步')
        elif '完成' in texts and '请选择中文键盘布局' in texts:click('完成')
        else:return
    raise AssertionError('Keyboard setup did not finish')

def type_at(label, text, clear=False):
    rows=layout()
    field=next((a for a in rows if a.get('type') in ('TextInput','TextArea') and (a.get('id') == label or a.get('hint') == label)),None)
    if field:run('shell','uitest','uiInput','click',*center(field))
    else:click(label)
    time.sleep(.4)
    if clear:run('shell','uitest','uiInput','keyEvent','2072','2017')
    if text: run('shell','uitest','uiInput','text',text)
    elif clear: run('shell','uitest','uiInput','keyEvent','2055')
    run('shell','uitest','uiInput','keyEvent','Back');time.sleep(.4)

def login(endpoint='http://127.0.0.1:19743'):
    run('shell','aa','start','-a','EntryAbility','-b','com.codoxear.mobile')
    for attempt in range(20):
        rows=layout()
        server=next((a for a in rows if a.get('type')=='TextInput' and a.get('id')!='password'),None)
        if server:break
        time.sleep(.5)
    assert server, 'Login form did not appear'
    run('shell','uitest','uiInput','click',*center(server));time.sleep(.5)
    time.sleep(3)
    initialize_keyboard()
    run('shell','uitest','uiInput','keyEvent','2072','2017')
    run('shell','uitest','uiInput','text',endpoint)
    run('shell','uitest','uiInput','keyEvent','Back');time.sleep(.5)
    type_at('password','native-test-password',True);click('Login');time.sleep(.7)
    assert node('New session'), 'Login did not reach catalog'

def capture(path):
    time.sleep(.5)
    remote=f'/data/local/tmp/codoxear-shot-{time.time_ns()}.png'
    run('shell','uitest','screenCap','-p',remote)
    target=Path(path).resolve()
    target.unlink(missing_ok=True)
    print(run('file','recv',remote,str(target)))
    run('shell','rm',remote)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['dump','login','click','type','capture','fold']);p.add_argument('args',nargs='*');a=p.parse_args()
    if a.action=='dump':
        for n in layout():
            if n.get('text') or n.get('id'):print(n.get('text',''),n.get('id',''),n.get('bounds',''))
    elif a.action=='login':login()
    elif a.action=='click':click(a.args[0])
    elif a.action=='type':type_at(a.args[0],a.args[1],True)
    elif a.action=='capture':capture(a.args[0])
    elif a.action=='fold':print(run('shell','hidumper','-s','DisplayManagerService','-a','-p' if a.args[0]=='outer' else '-y')[-600:])
