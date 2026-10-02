"""Docker-only synthetic Pi broker for child telemetry UI verification."""
import json,os,socket,sys,time
from pathlib import Path
assert Path('/.dockerenv').exists()
assert Path.home()==Path('/home/tester')
sid=sys.argv[1];home=Path.home();cwd=home/sid;cwd.mkdir(exist_ok=True)
root=home/'.local/share/codoxear/socks';root.mkdir(parents=True,exist_ok=True)
log=cwd/'parent.jsonl'
log.write_text('\n'.join(json.dumps(row) for row in [
 {'type':'session','version':3,'id':sid,'cwd':str(cwd)},
 {'type':'message','id':'request','message':{'role':'user','content':[{'type':'text','text':'Synthetic child telemetry verification'}]}},
 {'type':'message','id':'response','message':{'role':'assistant','content':[{'type':'text','text':'Parent finished; child work can continue.'}],'stopReason':'stop'}}
])+'\n')
sock=root/f'{sid}.sock';server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(str(sock));server.listen()
(root/f'{sid}.json').write_text(json.dumps({'session_id':sid,'agent_backend':'pi','broker_pid':os.getpid(),'codex_pid':os.getpid(),'cwd':str(cwd),'log_path':str(log),'sock_path':str(sock),'owner':'terminal','start_ts':time.time(),'control_protocol_version':2,'control_capabilities':{'sync_send':True,'key_write_errors':True}}))
while True:
 conn,_=server.accept()
 with conn:
  data=b''
  while b'\n' not in data:
   chunk=conn.recv(65536)
   if not chunk:break
   data+=chunk
  req=json.loads(data.split(b'\n')[0]);cmd=req.get('cmd')
  res={'busy':False,'queue_len':0,'token':None,'interrupted_idle':False} if cmd=='state' else {'error':'Read-only telemetry fixture'}
  conn.sendall((json.dumps(res)+'\n').encode())
