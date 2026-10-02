"""Dedicated Docker server with a small real transcript export limit."""
import json,os,subprocess,time
from pathlib import Path
assert Path('/.dockerenv').exists() and Path.home()==Path('/home/tester')
root=Path.home()/'.local/share/codoxear';root.mkdir(parents=True,exist_ok=True)
sid='native-export-limit'
(root/'session_aliases.json').write_text(json.dumps({sid:'Export limit verification'}))
subprocess.Popen(['python','/workspace/frontend/harmonyos/tests/fixture_backend.py',sid])
for _ in range(40):
 if (root/f'socks/{sid}.json').exists():break
 time.sleep(.1)
else:raise RuntimeError('Fixture broker failed to start')
os.execvp('python',['python','-m','codoxear.server'])
