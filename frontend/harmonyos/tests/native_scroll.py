"""Real native scrolling against the disposable Docker transcript fixture."""
import json, subprocess, time
from native_ui import click, node, layout, capture

def append(text):
    code = """import json,time
from pathlib import Path
from datetime import datetime,timezone
assert Path('/.dockerenv').exists()
row={'timestamp':datetime.now(timezone.utc).isoformat(),'type':'response_item','payload':{'type':'message','role':'assistant','phase':'final_answer','content':[{'type':'output_text','text':TEXT}]}}
with Path('/home/tester/native-parity.jsonl').open('a') as f:f.write(json.dumps(row)+'\\n')
""".replace('TEXT',repr(text))
    subprocess.run(['docker','--context','colima-codoxear-test','exec','codoxear-harmony-test','python3','-c',code],check=True)

stamp=str(time.time_ns())
# Entry state is the most recent user after clicking Previous user message.
anchor=node('Native notification verification')['bounds']
append('Background arrival '+stamp)
time.sleep(4)
assert node('Native notification verification')['bounds']==anchor, 'Incoming messages moved the reader away from their anchor'
click('Latest messages');time.sleep(2)
assert any('Background arrival '+stamp in n.get('text','') for n in layout())
append('## Tail follow '+stamp+'\n\n![Late image](native-chart.png)\n\nTail marker '+stamp)
time.sleep(4)
assert any('Tail marker '+stamp in n.get('text','') for n in layout()), 'New content/image sizing did not keep latest message visible'
capture('../../../artifacts/harmonyos/native-tail-follow.png')
print('PASS native selection tail, reader anchor, incoming tail and async image layout')
