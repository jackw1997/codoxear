"""Exercise the real composer against a dedicated Docker fixture on port 19754.

Requires fixture_backend.py composer-overflow, named native-parity-fixture,
and an explicit CODOXEAR_HDC_TARGET. Screenshots need visual inspection for
caret visibility and both scroll directions; text/size/persistence are asserted.
"""
import http.cookiejar, json, os, re, sys, time, urllib.request
from pathlib import Path
import native_ui as u

assert os.environ.get('CODOXEAR_HDC_TARGET'), 'Choose the owned emulator explicitly'
endpoint = 'http://127.0.0.1:19754'
prefix = '/api/sessions/composer-overflow'
evidence = Path(sys.argv[1]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
api = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def call(path, data=None):
    request = urllib.request.Request(endpoint + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    with api.open(request, timeout=15) as response: return json.load(response)
def field(): return u.node('message-input')
def key(*codes):
    u.run('shell', 'uitest', 'uiInput', 'keyEvent', *map(str, codes)); time.sleep(.3)
def bounds(): return list(map(int, re.findall(r'\d+', field()['bounds'])))
def height():
    _, top, _, bottom = bounds(); return bottom - top

def swipe(top):
    left, y, right, bottom = bounds(); x = str((left + right) // 2)
    start, end = (y + 70, bottom - 70) if top else (bottom - 70, y + 70)
    for _ in range(6):
        u.run('shell', 'uitest', 'uiInput', 'swipe', x, str(start), x, str(end), '1200')
    u.capture(evidence / ('scroll-top.png' if top else 'scroll-bottom.png'))

call('/api/login', {'password': 'native-test-password'})
before = call(prefix + '/messages/tail?limit=80')['events']
u.type_at('message-input', 'Short draft', True)
short_height = height()
u.type_at('message-input', 'First\nSecond\nThird', True)
assert height() > short_height, 'Composer did not grow'
long_text = '\n'.join(f'Line {i:02d} overflow check' for i in range(1, 26))
u.type_at('message-input', long_text, True)
assert field()['text'] == long_text and field()['scrollable'] == 'true'
capped_height = height()
u.click('message-input'); key(2072, 2082)
extra = '\nLAST LINE visible 中文 🐟'
u.run('shell', 'uitest', 'uiInput', 'text', extra)
assert field()['text'] == long_text + extra
assert height() == capped_height, 'Long draft grew beyond the cap'
u.capture(evidence / 'continued-input.png')
swipe(True); swipe(False)
# Wrapped text also exceeds the viewport without explicit line breaks.
wrapped = ('中文草稿 🐟 wrapped draft ' * 60) + 'WRAPPED END'
u.type_at('message-input', wrapped, True)
assert field()['text'] == wrapped and field()['scrollable'] == 'true'
u.capture(evidence / 'wrapped.png')
u.type_at('message-input', 'Short again', True)
assert height() == short_height, 'Composer did not shrink after replacement'
# Restore long text and verify durable draft state with an independent client.
u.type_at('message-input', long_text + extra, True)
for _ in range(30):
    if call(prefix + '/draft')['text'] == long_text + extra: break
    time.sleep(.3)
else: raise AssertionError('Long draft was not saved')
u.run('shell', 'aa', 'force-stop', 'com.codoxear.mobile'); u.login(endpoint)
if not any(n.get('id') == 'message-input' for n in u.layout()): u.click('native-parity-fixture')
assert field()['text'] == long_text + extra and field()['scrollable'] == 'true'
assert call(prefix + '/messages/tail?limit=80')['events'] == before, 'Draft editing sent a message'
u.capture(evidence / 'restored.png')
print('PASS growth, capped viewport, scrollability, continued input, wrapped Unicode, shrink, server draft, restart and no sends')
print('Inspect continued-input, scroll-top, scroll-bottom and wrapped screenshots for visual scroll/caret evidence.')
