"""Native conversation smoke for real Docker CLIs; never uses host sessions.
Requires the explicitly prepared native-cli-smoke container sessions. This test
sends one short no-tool prompt per backend and checks the native rendered reply.
"""
import time,sys
import native_ui as u

def wait_text(value, timeout=90):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        if any(n.get('text')==value for n in u.layout()):return
        time.sleep(1)
    raise AssertionError('Native reply not displayed: '+value)

u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744')
for backend in ('pi','codex','cc'):
    if backend!='pi':u.click('Sessions')
    u.click('Native real '+backend)
    marker='NATIVE_UI_'+backend.upper()+'_'+str(time.time_ns())
    u.type_at('message-input','Reply exactly '+marker+'. Do not use tools or read files.',True);u.click('Send')
    wait_text(marker)
    assert u.node('message-input')['text']=='', 'Composer did not clear'
    u.capture('../../../artifacts/harmonyos/native-real-'+backend+'.png')
    print('PASS native send/render '+backend,flush=True)
print('PASS native real Pi/Codex/Claude Code conversation UI')
