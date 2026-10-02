"""Dedicated Docker server with an old pending attachment and no staged entry."""
import json,os,subprocess,time
from pathlib import Path
assert Path('/.dockerenv').exists()
assert Path.home()==Path('/home/tester')
root=Path.home()/'.local/share/codoxear';root.mkdir(parents=True,exist_ok=True)
sid='native-legacy-attachment'
(root/'pending_attachments.json').write_text(json.dumps([sid]))
(root/'session_aliases.json').write_text(json.dumps({sid:'Legacy attachment verification'}))
child=subprocess.Popen(['python','/workspace/frontend/harmonyos/tests/fixture_backend.py',sid])
for _ in range(40):
 if (root/f'socks/{sid}.json').exists():break
 time.sleep(.1)
else:raise RuntimeError('Fixture broker failed to start')
os.execvp('python',['python','-m','codoxear.server'])
