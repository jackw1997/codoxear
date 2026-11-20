"""Disposable Docker fixture for native_css_leading.py; no host runtime data."""
import json, subprocess, time
from pathlib import Path
assert Path('/.dockerenv').exists() and str(Path.home()) == '/home/tester'
subprocess.Popen(['python3','/workspace/frontend/harmonyos/tests/fixture_backend.py','css-leading'])
for _ in range(100):
    if (Path.home()/'.local/share/codoxear/socks/css-leading.json').exists():break
    time.sleep(.1)
p=Path.home()/'css-leading.jsonl'
meta=json.loads(p.read_text().splitlines()[0])
rows=[meta, {'type':'response_item','payload':{'type':'message','role':'assistant','phase':'final_answer','content':[{'type':'output_text','text':'Leading one\nLeading two\nLeading three'}]}}]
rows.append({'type':'event_msg','payload':{'type':'task_complete','last_agent_message':'Leading one\nLeading two\nLeading three'}})
p.write_text('\n'.join(json.dumps(row) for row in rows)+'\n')
from codoxear.server import main
main()
