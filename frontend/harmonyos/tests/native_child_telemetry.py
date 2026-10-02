"""Native child details refresh while count is unchanged; independent completion."""
import json,runpy,subprocess,time
import native_ui as u
call=runpy.run_path('/tmp/codoxear-cli-common.py')['call']
sid='native-children-'+str(time.time_ns());alias='Child telemetry verification'
base=['docker','--context','colima-codoxear-test','exec','-u','tester','codoxear-harmony-test']
def docker(code):return subprocess.check_output(base+['python','-c',code],text=True)
def catalog():return next((s for s in call('/api/sessions')['sessions'] if s['session_id']==sid),None)
def wait(check,seconds=20):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if check():return
  time.sleep(.4)
 raise AssertionError('Child telemetry did not converge')
def texts():return [n.get('text','') for n in u.layout()]
def write():docker(f'from pathlib import Path;p=Path({status_path!r});p.parent.mkdir(parents=True,exist_ok=True);p.write_text({json.dumps(status)!r})')
subprocess.run(base[:4]+['-d']+base[4:]+['python','/workspace/frontend/harmonyos/tests/fixture_children.py',sid],check=True)
wait(lambda:catalog())
row=catalog();pid=row['broker_pid'];assert row['agent_backend']=='pi'
uid=docker('import os;print(os.getuid())').strip()
status_path=f'/tmp/pi-subagents-uid-{uid}/async-subagent-runs/{sid}/status.json'
status={'lifecycleArtifactVersion':3,'runId':sid,'sessionId':row['log_path'],'state':'running','startedAt':time.time()*1000,'pid':pid,'steps':[
 {'agent':'reviewer','status':'running','model':'fixture/model-a','toolCount':2,'tokens':{'total':1200}},
 {'agent':'worker','status':'running','model':'fixture/model-b','toolCount':4,'tokens':{'total':2400}}]}
try:
 call(f'/api/sessions/{sid}/rename',{'name':alias});write();wait(lambda:catalog().get('subagents_running')==2)
 u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session(alias)
 u.node('▸2 subagents working');u.node('reviewer · model-a · tools: 2 · tokens: 1.2k');u.node('worker · model-b · tools: 4 · tokens: 2.4k')
 status['steps'][0].update(toolCount=3,tokens={'total':1300});status['steps'][1].update(toolCount=5,tokens={'total':2500});write()
 wait(lambda:catalog()['subagent_details'][0]['tools']==3)
 assert catalog()['subagents_running']==2
 u.node('reviewer · model-a · tools: 3 · tokens: 1.3k');u.node('worker · model-b · tools: 5 · tokens: 2.5k')
 u.capture('../../../artifacts/harmonyos/native-child-telemetry.png')
 status['steps'][0]['status']='complete';write();wait(lambda:catalog()['subagents_running']==1)
 u.node('▸1 subagent working');u.node('worker · model-b · tools: 5 · tokens: 2.5k')
 assert not any(t.startswith('reviewer ·') for t in texts())
 status['steps'][1]['status']='complete';status['state']='complete';write();wait(lambda:catalog()['subagents_running']==0)
 wait(lambda:not any('subagent working' in t or 'subagents working' in t or t.startswith('worker ·') for t in texts()))
 u.capture('../../../artifacts/harmonyos/native-child-complete.png')
 print('PASS idle parent retains two children; unchanged count refreshes tool/token details; individual completion removes only finished child; all complete removes activity')
finally:
 docker(f'from pathlib import Path;Path({status_path!r}).unlink(missing_ok=True)')
 docker(f"import os,signal;from pathlib import Path;args=Path('/proc/{pid}/cmdline').read_bytes().split(bytes([0]));assert b'/workspace/frontend/harmonyos/tests/fixture_children.py' in args and {sid.encode()!r} in args;os.kill({pid},signal.SIGTERM)")
 call(f'/api/sessions/{sid}/delete',{})
