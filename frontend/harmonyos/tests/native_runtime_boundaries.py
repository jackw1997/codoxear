"""Actual runtime counters, repeated polling, closed-turn reset and log rebind."""
import json, runpy, subprocess, time
from datetime import datetime, timezone
import native_ui as u

call = runpy.run_path('/tmp/codoxear-cli-common.py')['call']
sid = 'native-runtime-boundary'
original_log = f'/home/tester/{sid}.jsonl'
log = f'/home/tester/{sid}-{time.time_ns()}.jsonl'
def docker(code):
    return subprocess.check_output(['docker', '--context', 'colima-codoxear-test', 'exec', '-u', 'tester', 'codoxear-harmony-test', 'python', '-c', code], text=True)
def append(payloads, path=log):
    rows = [{'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), 'type': kind, 'payload': data} for kind, data in payloads]
    data = ''.join(json.dumps(row) + '\n' for row in rows)
    docker(f'from pathlib import Path;p=Path({path!r});f=p.open("a");f.write({data!r});f.close()')
def token(reasoning, used):
    return ('event_msg', {'type': 'token_count', 'info': {'total_token_usage': {'reasoning_output_tokens': reasoning}, 'model_context_window': 100000, 'last_token_usage': {'total_tokens': used}}})
def tool(index): return ('response_item', {'type': 'function_call', 'name': 'fixture_tool', 'call_id': f'call{index}', 'arguments': '{}'})
def user(text): return ('event_msg', {'type': 'user_message', 'message': text, 'images': []})
def busy(on):
    docker(f"from pathlib import Path;p=Path('/home/tester/{sid}.busy');" + ('p.touch()' if on else 'p.unlink(missing_ok=True)'))
def catalog(): return next(s for s in call('/api/sessions')['sessions'] if s['session_id'] == sid)
def wait(check, seconds=15):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if check(): return
        time.sleep(.5)
    raise AssertionError('Runtime state did not converge')
def texts(): return [n.get('text','') for n in u.layout()]
def context(): return 'Ctx ' + str(round(catalog()['token']['percent_remaining'])) + '%'
def label(tools, thinking): return f'•••  tools: {tools} · thinking: {thinking}'

call(f'/api/sessions/{sid}/rename', {'name': 'Runtime boundary verification'})
busy(False)
append([('session_meta',{'id':sid,'cwd':'/home/tester/native-runtime-boundary','source':'cli','model_provider':'fixture'}),('event_msg', {'type':'task_complete','last_agent_message':'Runtime fixture ready'})])
docker(f"import json;from pathlib import Path;p=Path('/home/tester/.local/share/codoxear/socks/{sid}.json');d=json.loads(p.read_text());d['log_path']={log!r};p.write_text(json.dumps(d))")
wait(lambda:catalog().get('log_path')==log,25)
u.run('shell','aa','force-stop','com.codoxear.mobile');u.login('http://127.0.0.1:19744');u.select_session('Runtime boundary verification')
try:
    busy(True);append([user('Runtime counters first turn'),tool(1),tool(2),tool(3),token(1200,25000)])
    wait(lambda: catalog()['tools']==3)
    u.node(label(3,'1.2k'));u.node(context())
    time.sleep(6);u.node(label(3,'1.2k'))
    u.capture('../../../artifacts/harmonyos/native-runtime-counters.png')
    append([tool(4),token(1500,40000)])
    wait(lambda: catalog()['tools']==4)
    u.node(label(4,'1.5k'));u.node(context())
    time.sleep(4);u.node(label(4,'1.5k'))
    print('PASS live catalog/delta updates count each tool/reasoning increment once across repeated polling',flush=True)
    busy(False);append([('event_msg',{'type':'task_complete','last_agent_message':'First runtime turn finished'})])
    wait(lambda:not catalog()['busy']);wait(lambda:not any(t.startswith('•••') for t in texts()))
    busy(True);append([user('Runtime counters fresh turn'),tool(5),token(1700,10000)])
    wait(lambda:catalog()['tools']==1)
    u.node(label(1,'200'));u.node(context())
    print('PASS completed turn hides working state and new human turn resets counters',flush=True)
    # Change the real broker sidecar to a different log, as a restarted CLI does.
    rebound = f'/home/tester/{sid}-rebound.jsonl'
    docker(f'from pathlib import Path;Path({rebound!r}).write_text("")')
    append([('session_meta',{'id':sid+'-rebound','cwd':'/home/tester/native-runtime-boundary','source':'cli','model_provider':'fixture'}), user('Rebound runtime transcript'),tool(6),token(70,50000)],rebound)
    docker(f"import json;from pathlib import Path;p=Path('/home/tester/.local/share/codoxear/socks/{sid}.json');d=json.loads(p.read_text());d['log_path']={rebound!r};d['session_id']={sid+'-rebound'!r};p.write_text(json.dumps(d))")
    wait(lambda:catalog().get('log_path')==rebound,25)
    u.node('Rebound runtime transcript');u.node(label(1,'70'));u.node(context())
    assert 'Runtime counters fresh turn' not in texts(), 'Old transcript survived rebind'
    u.capture('../../../artifacts/harmonyos/native-runtime-rebound.png')
    print('PASS log rebind replaces transcript, counters and context without stale values',flush=True)
except Exception:
    print('Observed UI:', [t for t in texts() if t],flush=True)
    print('Observed server:',{k:catalog().get(k) for k in ('tools','thinking_tokens','busy','token','log_path')},flush=True)
    u.capture('../../../artifacts/harmonyos/native-runtime-failure.png')
    raise
finally:
    busy(False)
    append([('event_msg',{'type':'task_complete','last_agent_message':'Runtime verification finished'})])
    docker(f"import json;from pathlib import Path;p=Path('/home/tester/.local/share/codoxear/socks/{sid}.json');d=json.loads(p.read_text());d['log_path']={original_log!r};d['session_id']={sid!r};p.write_text(json.dumps(d))")
