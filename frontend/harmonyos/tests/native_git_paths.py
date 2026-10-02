"""Tracked Git paths use repo coordinates; untracked files use the session cwd."""
import json,time
import native_ui as u
entries=json.load(open('/tmp/codoxear-native-git-scope.json'))
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Nested path verification')
def changes():u.click('Files');u.click('Git changes')
changes();u.click(next(e['path'] for e in entries if '000-native-git' in e['path']))
u.node('-NATIVE_GIT_BEFORE');u.node('+NATIVE_GIT_AFTER');u.capture('../../../artifacts/harmonyos/native-git-raw-diff.png');u.click('Close')
changes();u.node('+? −?');u.click(next(e['path'] for e in entries if '001-native-binary' in e['path']))
assert any('Binary files' in n.get('text','') and 'differ' in n.get('text','') for n in u.layout())
u.capture('../../../artifacts/harmonyos/native-git-binary.png');u.click('Close')
changes();u.click(next(e['path'] for e in entries if e.get('untracked')))
u.node('NATIVE_UNTRACKED_CWD_VERIFIED');u.capture('../../../artifacts/harmonyos/native-git-untracked-path.png')
print('PASS raw-byte tracked text/binary Git diffs resolve from repository root; raw-byte untracked file opens from nested session cwd')
