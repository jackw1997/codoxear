"""Synthetic broker for native/web parity tests. Run ONLY inside isolated Docker.

Exercises the real HTTP server and transcript parser; does not validate a real
agent CLI, billing, or model inference. No host logs or credentials are read.
"""
import json, os, socket, sys, threading, time
from pathlib import Path
from datetime import datetime, timezone

assert Path('/.dockerenv').exists(), 'Fixture is container-only'
home = Path.home()
assert str(home) == '/home/tester'
socks = home / '.local/share/codoxear/socks'
socks.mkdir(parents=True, exist_ok=True)
project = Path(os.environ.get('CODOXEAR_NATIVE_FIXTURE_CWD', str(home / 'native-parity-fixture')))
assert project.is_relative_to(home), 'Fixture cwd must stay inside disposable Docker home'
project.mkdir(parents=True, exist_ok=True)
if not (project / 'example.py').exists(): (project / 'example.py').write_text('def greet(name: str) -> str:\n    return f"Hello, {name}!"\n')
if not (project / 'README.md').exists(): (project / 'README.md').write_text('# Native parity fixture\n\nThis is synthetic test data.\n')

def stamp(): return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
def append(log, role, text):
    rows=[]
    if role == 'user': rows.append({'timestamp':stamp(),'type':'event_msg','payload':{'type':'user_message','message':text,'images':[]}})
    else:
        rows.append({'timestamp':stamp(),'type':'response_item','payload':{'type':'message','role':role,'phase':'final_answer','content':[{'type':'output_text','text':text}]}})
        rows.append({'timestamp':stamp(),'type':'event_msg','payload':{'type':'task_complete','last_agent_message':text}})
    with log.open('a') as f:
        for row in rows: f.write(json.dumps(row)+'\n')


def broker(sid):
    log = home / f'{sid}.jsonl'
    log.write_text(json.dumps({'timestamp':stamp(),'type':'session_meta','payload':{'id':sid,'cwd':str(project),'source':'cli','model_provider':'fixture'}})+'\n')
    append(log, 'user', 'Please review example.py and summarize the changes.\n请同时检查折叠前后的草稿与滚动位置。')
    append(log, 'assistant', '## Review complete\n\nThe function uses **typed parameters** and a `str` return value.\n\n```python\ndef greet(name: str) -> str:\n    return f"Hello, {name}!"\n```\n\n| Check | Result |\n| --- | --- |\n| Encoding | UTF-8 |\n| Draft | Preserved |\n\n- Open [example.py](example.py) to inspect it.\n- Queue a follow-up message.\n\n> Synthetic fixture; no model inference is involved.')
    for index in range(int(sys.argv[2]) if len(sys.argv) > 2 else 0):
        append(log, 'user', f'History question {index:03d}')
        append(log, 'assistant', f'History answer {index:03d}\n\nSynthetic content for native history scrolling.')
    sock = socks / f'{sid}.sock'
    sock.unlink(missing_ok=True)
    server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(str(sock));server.listen()
    (socks/f'{sid}.json').write_text(json.dumps({'session_id':sid,'agent_backend':'codex','broker_pid':os.getpid(),'codex_pid':os.getpid(),'cwd':str(project),'log_path':str(log),'sock_path':str(sock),'owner':'terminal','start_ts':time.time(),'control_protocol_version':2,'control_capabilities':{'sync_send':True,'key_write_errors':True},'model':'fixture-model','model_provider':'fixture','slash_commands': [{'name':'model'}, {'name':'effort'}] if os.environ.get('CODOXEAR_FIXTURE_SETTINGS') else []}))
    def handle(conn):
        with conn:
            buf=b''
            while b'\n' not in buf:
                chunk=conn.recv(65536)
                if not chunk: break
                buf+=chunk
            try:
                req=json.loads(buf.split(b'\n')[0]);cmd=req.get('cmd')
                if cmd=='state':res={'busy':(home/f'{sid}.busy').exists(),'queue_len':0,'token':None,'interrupted_idle':False}
                elif cmd=='send':
                    reject = home / f'{sid}.reject-send'
                    if reject.exists() or (home / f'{sid}.reject-all-sends').exists():
                        reject.unlink(missing_ok=True)
                        with (home / f'{sid}.rejected.jsonl').open('a') as rejected:
                            rejected.write(json.dumps({'text': req.get('text', ''), 'ts': time.time()}) + '\n')
                        conn.sendall((json.dumps({'error': 'Synthetic attachment injection rejected'})+'\n').encode())
                        return
                    hold = home / f'{sid}.hold-send'
                    deadline = time.monotonic() + 25
                    while hold.exists() and time.monotonic() < deadline:
                        time.sleep(.05)
                    # A one-shot lost broker acknowledgment exercises the real
                    # server's durable queue recovery path, after a real commit.
                    drop = home / f'{sid}.drop-send-response'
                    if drop.exists():
                        drop.unlink()
                        # Simulate accepted input whose transcript has not yet
                        # flushed. Keep separate evidence of the committed input.
                        with (home / f'{sid}.committed.jsonl').open('a') as committed:
                            committed.write(json.dumps({'text': req['text']}) + '\n')
                        return
                    append(log,'user',req['text']);append(log,'assistant','Fixture acknowledged: '+req['text'])
                    res={'queued':False,'queue_len':0,'busy':False}
                elif cmd=='settings':
                    with (home/f'{sid}.settings.jsonl').open('a') as evidence:
                        evidence.write(json.dumps(req)+'\n')
                    res = {'error':'Synthetic setting rejected'} if (home/f'{sid}.reject-settings').exists() else {'ok':True}
                elif cmd=='tail':res={'tail':'Synthetic fixture terminal'}
                else:res={'ok':True}
                conn.sendall((json.dumps(res)+'\n').encode())
            except Exception as e:conn.sendall((json.dumps({'error':str(e)})+'\n').encode())
    while True:
        conn, _ = server.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()

broker(sys.argv[1] if len(sys.argv) > 1 else 'native-parity')
