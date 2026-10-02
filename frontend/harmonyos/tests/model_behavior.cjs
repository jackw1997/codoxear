// Execute the actual ArkTS models, with platform I/O replaced at its boundary.
// SDK compilation and emulator UI verification remain separate required checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || '/Applications/DevEco-Studio.app/Contents/tools/ohpm/node_modules/typescript');
const root = path.resolve(__dirname, '../entry/src/main/ets');
const timers = new Map();
let timerId = 0;
const cache = new Map();
const kits = {
  '@kit.PushKit': { pushService: {} },
  '@kit.MediaKit': { media: {} },
  '@kit.NotificationKit': { notificationManager: {} },
  '@kit.AbilityKit': {},
  '@kit.BasicServicesKit': {request: {}},
  '@kit.ArkTS': { util: {} },
  '@kit.CoreFileKit': { fileIo: {} },
  '@kit.NetworkKit': { http: { RequestMethod: { GET: 'GET', POST: 'POST' } } }
};
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }
  }).outputText;
  vm.runInNewContext(compiled, {
    exports, Observed: value => value,
    require: name => {
      if (kits[name]) return kits[name];
      const base=path.resolve(path.dirname(file),name);
      return load(fs.existsSync(base+'.ets') ? base+'.ets' : base+'.js');
    },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => -1, clearInterval: () => {},
    console
  }, { filename: file });
  return exports;
}
async function flushDrafts() {
  for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
const { Workspace } = load(path.join(root, 'model/Workspace.ets'));
const { EditHistory, codeLines } = load(path.join(root, 'model/CodeDocument.ets'));
const { markdownBlocks, inlineParts, measureInlineWidth } = load(path.join(root, 'model/Markdown.ets'));
async function main() {
  const { transcriptDayLabel, startsTranscriptDay, transcriptGap } = load(path.join(root, 'model/TranscriptPresentation.ets'));
  const now=new Date(2026,9,2,12).getTime(), today=new Date(2026,9,2,9).getTime()/1000, yesterday=new Date(2026,9,1,23).getTime()/1000;
  assert.equal(transcriptDayLabel(today,now),'Today (2026-10-02)');
  assert.equal(transcriptDayLabel(yesterday,now),'Yesterday (2026-10-01)');
  assert.equal(transcriptDayLabel(0,now),'');
  const decorated=[{role:'user',ts:yesterday},{role:'assistant',ts:today},{role:'assistant',ts:today+1},{role:'assistant',ts:0},{role:'user',ts:today+2}];
  assert.deepEqual(decorated.map((_,i)=>startsTranscriptDay(decorated,i)),[true,true,false,false,false]);
  assert.deepEqual(decorated.map((_,i)=>transcriptGap(decorated,i)),[6,6,2,6,6]);
  const sessionPresentation=load(path.join(root,'model/SessionPresentation.ets'));
  const card = {session_id:'stable',alias:'Stable',busy:false,updated_ts:100};
  assert.equal(sessionPresentation.sessionCardKey(card,120000),sessionPresentation.sessionCardKey({...card,time_priority:47,token:{used:999},tools:7},120000));
  assert.notEqual(sessionPresentation.sessionCardKey(card,120000),sessionPresentation.sessionCardKey({...card,busy:true},120000));
  assert.notEqual(sessionPresentation.sessionCardKey(card,120000),sessionPresentation.sessionCardKey({...card,alias:'Renamed'},120000));
  assert.notEqual(sessionPresentation.sessionCardKey(card,120000),sessionPresentation.sessionCardKey({...card,queue_len:1},120000));
  assert.notEqual(sessionPresentation.sessionCardKey(card,120000),sessionPresentation.sessionCardKey(card,180000));

  const metaFixture={session_id:'meta',cwd:'/work/project/',agent_backend:'cc',model:'provider-with-long-name/short',reasoning_effort:' HIGH ',updated_ts:100,git_branch:' main '};
  assert.equal(sessionPresentation.sessionMetadata(metaFixture,220000),'2m ago | provider-…/short ·hi* | project | main');
  assert.equal(sessionPresentation.sessionModel({model:'default'}),'');
  assert.equal(sessionPresentation.sessionModel({model:'abcdefghijklmnopqrstuv'}),'abcdef…opqrstuv');
  assert.equal(sessionPresentation.sessionEffort({reasoning_effort:'unsupported',agent_backend:'pi'}),'');
  assert.equal(sessionPresentation.sessionAge({start_ts:100},3700000),'1h ago');
  assert.equal(sessionPresentation.sessionAge({updated_ts:500},100000),'just now');
  assert.equal(sessionPresentation.sessionAge({launch_state:'starting'},100000),'starting');
  assert.equal(sessionPresentation.sessionAge({lost:true,launch_state:'starting'},100000),'lost');
  assert.equal(sessionPresentation.sessionLaunchIcon({owned:true,transport:'tmux'}),'tmux');
  assert.equal(sessionPresentation.sessionLaunchIcon({owned:true}),'web');
  assert.equal(sessionPresentation.sessionLaunchIcon({lost:true,transport:'tmux'}),'info');
  assert.equal(sessionPresentation.sessionBackend({agent_backend:'unknown'}),'codex');
  const { KeyboardHints } = load(path.join(root, 'model/KeyboardHints.ets'));
  const hints = new KeyboardHints(), activated = [];
  const viewport={x:0,y:0,width:400,height:800};
  const control=(id,scope,extra={})=>({id,label:'Control '+id,scope,preferred:'',session:false,bounds:{x:0,y:id*10,width:30,height:20},visible:true,enabled:()=>true,activate:()=>activated.push(id),...extra});
  hints.update(control(1,'chat',{preferred:'b'}));hints.update(control(2,'panel',{preferred:'b'}));
  hints.update(control(3,'panel',{visible:false}));hints.update(control(4,'panel',{enabled:()=>false}));
  hints.update(control(5,'panel',{bounds:{x:401,y:0,width:20,height:20}}));
  hints.enter(['panel'],viewport);assert.equal(hints.badges.length,1);hints.key('b');assert.deepEqual(activated,[2]);
  hints.focus('first');assert.equal(hints.enter(['chat'],viewport),false);
  hints.focus('second');hints.blur('first');assert.equal(hints.typing(),true);hints.blur('second');
  hints.enter(['chat'],viewport);hints.key('Escape');assert.equal(hints.active(),false);assert.deepEqual(activated,[2]);
  hints.enter(['chat'],viewport);hints.update(control(1,'chat',{preferred:'b',enabled:()=>false}));hints.key('b');assert.deepEqual(activated,[2]);
  for(let id=10;id<50;id++)hints.update(control(id,'sidebar',{session:id<20}));
  hints.enter(['sidebar'],viewport);assert.equal(hints.badges.length,40);assert.equal(new Set(hints.badges.map(b=>b.label)).size,40);
  assert.deepEqual(Array.from(hints.badges.slice(0,9),b=>b.label),['1','2','3','4','5','6','7','8','9']);
  const overflow=hints.badges.find(b=>b.label.length>1);for(const key of overflow.label)assert.equal(hints.key(key),true);assert.equal(activated.at(-1),overflow.id);
  hints.enter(['sidebar'],viewport);hints.update(control(10,'sidebar',{session:true,bounds:{x:20,y:100,width:30,height:20}}));assert.equal(hints.active(),false);
  hints.enter(['sidebar'],viewport);hints.update(control(10,'sidebar',{session:true,label:'Changed action'}));assert.equal(hints.active(),false);
  hints.enter(['sidebar'],viewport);hints.key('Backspace');assert.equal(hints.active(),false);
  hints.enter(['sidebar'],viewport);hints.remove(hints.badges[0].id);assert.equal(hints.active(),false);

  // Direct dialog letters follow the web's first distinctive character rule,
  // but must never activate background, disabled, clipped, or text controls.
  const dialogHints=new KeyboardHints(), dialogActions=[];
  const dialogControl=(id,label,extra={})=>control(id,'panel',{label,button:true,activate:()=>dialogActions.push(label),...extra});
  dialogHints.update(dialogControl(1,'Close'));dialogHints.update(dialogControl(2,'Copy conversation'));
  dialogHints.update(dialogControl(3,'Cancel',{enabled:()=>false}));
  dialogHints.update(dialogControl(4,'Launch',{scope:'chat'}));
  dialogHints.update(dialogControl(5,'Output',{button:false}));
  dialogHints.update(dialogControl(6,'Later',{bounds:{x:0,y:900,width:30,height:20}}));
  assert.equal(dialogHints.dialogKey('c',viewport),false);
  assert.equal(dialogHints.dialogKey('L',viewport),true);assert.deepEqual(dialogActions,['Close']);
  assert.equal(dialogHints.dialogKey('o',viewport),true);assert.deepEqual(dialogActions,['Close','Copy conversation']);
  dialogHints.focus('form');assert.equal(dialogHints.dialogKey('l',viewport),false);dialogHints.blur('form');
  dialogHints.enter(['panel'],viewport);assert.equal(dialogHints.dialogKey('l',viewport),false);dialogHints.exit();
  dialogHints.remove(2);assert.equal(dialogHints.dialogKey('l',viewport),false);
  assert.equal(dialogHints.dialogKey('c',viewport),true);assert.equal(dialogHints.dialogKey('Escape',viewport),false);
  dialogHints.update(dialogControl(1,'Close',{visible:false}));assert.equal(dialogHints.dialogKey('c',viewport),false);

  // Enqueue can send immediately or preserve an uncertain item. A subsequent
  // read failure must not reclassify an acknowledged mutation as an unknown send.
  for (const result of [{queued:true},{queued:false},{queued:true,commit_unknown:true}]) {
    const accepted=new Workspace();accepted.selected={session_id:'accepted'};
    accepted.setDraft('exactly once');accepted.api.request=async()=>JSON.stringify(result);
    accepted.loadAttachments=async()=>{};accepted.poll=async()=>{};accepted.loadQueue=async()=>{};
    await accepted.send(true);
    assert.equal(accepted.notice,result.commit_unknown?'Send status unknown; queued item needs review.':result.queued?'Queued':'Sent');
    assert.equal(accepted.draft,'');assert.equal(accepted.unknownSend(),false);
  }
  const refreshedSend=new Workspace();refreshedSend.selected={session_id:'refresh-failure'};refreshedSend.setDraft('acknowledged');
  refreshedSend.api.request=async()=>'{}';refreshedSend.loadAttachments=async()=>{throw new Error('connection closed');};
  await refreshedSend.send();
  assert.equal(refreshedSend.draft,'');assert.equal(refreshedSend.unknownSend(),false);
  assert.match(refreshedSend.error,/Message accepted, but refreshing failed/);

  // Native empty-string measurement returns a huge negative sentinel on API24.
  // Hard breaks must preserve the longest actual line across differently styled runs.
  const widthParts=inlineParts('Long **styled** line\n中文\nlast');
  const measured=[];
  const width=measureInlineWidth(widthParts,(text)=>{measured.push(text);return text ? Array.from(text).length*10 : -9.7e37;});
  assert.equal(width,160);assert.ok(measured.every(text=>text.length>0));
  assert.equal(measureInlineWidth(inlineParts('short'),()=>-1),Infinity);
  assert.equal(measureInlineWidth(inlineParts('short'),()=>NaN),Infinity);
  assert.equal(measureInlineWidth(inlineParts('a\n\nb'),text=>text.length*10),10);

  const citation='<oai-mem-citation>\n<citation_entries>\nnotes.md:12-18|note=[Earlier decision]\n</citation_entries>\n<rollout_ids>internal-id</rollout_ids>\n</oai-mem-citation>';
  const citationBlocks=markdownBlocks('Answer.\n'+citation);
  const citationParts=citationBlocks.flatMap(block=>block.parts);
  assert.ok(citationParts.some(part=>part.text.includes('Memory citations:')));
  assert.ok(citationParts.some(part=>part.text==='Earlier decision'&&part.url==='~/.codex/memories/notes.md#L12-18'));
  assert.ok(!citationParts.some(part=>part.text.includes('internal-id')));
  assert.equal(markdownBlocks('```xml\n'+citation+'\n```')[0].kind,'code');
  const invalidCitation=markdownBlocks(citation.replace('notes.md:12-18|note=[Earlier decision]','malformed'));
  assert.ok(!invalidCitation.flatMap(block=>block.parts).some(part=>part.url));
  const {fileLink:resolveCitationLink}=load(path.join(root,'model/FileLinks.ets'));
  assert.equal(resolveCitationLink('docs/readme.md','~/.codex/memories/notes.md#L12-18'),'~/.codex/memories/notes.md#L12-18');

  const {fileReferenceParts}=load(path.join(root,'model/Markdown.ets'));
  const referenceSource='See example.py:40 and **docs/readme.md#L12**; `ignored.py` and https://example.com remain unchanged.';
  const referenceParts=fileReferenceParts(inlineParts(referenceSource));
  assert.deepEqual(Array.from(referenceParts.filter(p=>p.candidate).map(p=>p.candidate)),['example.py:40','docs/readme.md#L12']);
  assert.ok(referenceParts.find(p=>p.candidate==='docs/readme.md#L12').bold);
  assert.equal(referenceParts.map(p=>p.text).join(''),inlineParts(referenceSource).map(p=>p.text).join(''));
  assert.equal(fileReferenceParts(inlineParts('a.com v1.2 3.14')).some(p=>p.candidate),false);
  const {inspectReferences}=load(path.join(root,'services/FileReferences.ets'));
  const referenceCalls=[];let connection=1;
  const referenceApi={connectionVersion:()=>connection,requireConnection:v=>{if(v!==connection)throw new Error('stale connection');},request:async(_path,_method,body)=>{
    if(_path.includes('/file/search?'))return JSON.stringify({matches:[]});
    const request=JSON.parse(body);referenceCalls.push(request);
    return JSON.stringify({results:request.paths.map(path=>({exists:path!=='missing.py',kind:path==='folder'?'directory':'text',resolved_path:'/root/'+path}))});
  }};
  const resolvedReferences=await inspectReferences(referenceApi,'session-one',['one.py','one.py','missing.py','folder']);
  assert.equal(resolvedReferences.length,2);assert.equal(resolvedReferences[1].directory,true);assert.equal(resolvedReferences[0].target,'/root/one.py');
  assert.equal(referenceCalls[0].session_id,'session-one');assert.equal(referenceCalls[0].paths.length,3);
  referenceCalls.length=0;
  await inspectReferences(referenceApi,'session-two',Array.from({length:101},(_,i)=>'folder/'+i+'.py'));
  assert.deepEqual(referenceCalls.map(call=>call.paths.length),[50,50,1]);
  referenceApi.request=async()=>JSON.stringify({matches:[{path:'one/same.py'},{path:'two/same.py'}]});
  const ambiguous=await inspectReferences(referenceApi,'session-two',['same.py']);
  assert.equal(ambiguous[0].choice,true);assert.equal(ambiguous[0].target,'same.py');
  const rawIdentity='codoxear-git-path-bytes-v1:L3Jhdy3_L2ZpbGUucHk';
  referenceApi.request=async(url,method,body)=>{
    if(url.includes('/file/search?'))return JSON.stringify({mode:'git',matches:[{path:'raw-display/file.py',api_path:'relative-token'}]});
    assert.equal(JSON.parse(body).path_token,'relative-token');assert.equal(JSON.parse(body).git_path,false);
    return JSON.stringify({path:'/raw-display/file.py',api_path:rawIdentity,kind:'text'});
  };
  const rawReference=(await inspectReferences(referenceApi,'raw',['file.py']))[0];
  assert.equal(rawReference.apiPath,rawIdentity);
  const {fileReferenceLink,parseFileReferenceLink}=load(path.join(root,'model/FileLinks.ets'));
  const rawLink=parseFileReferenceLink(fileReferenceLink(rawReference.target,'#L40',rawReference.apiPath));
  assert.equal(rawLink.apiPath,rawIdentity);assert.equal(rawLink.location,'#L40');assert.equal(rawLink.path,'/raw-display/file.py');
  assert.equal(parseFileReferenceLink('codoxear-file:%invalid'),null);
  assert.equal(parseFileReferenceLink('codoxear-file:'+encodeURIComponent('{"path":42}')),null);
  referenceApi.request=async()=>{connection++;return JSON.stringify({results:[]});};
  await assert.rejects(inspectReferences(referenceApi,'old',['folder/one.py']),/stale connection/);

  const referenceWorkspace=new Workspace();referenceWorkspace.selected={session_id:'reference-session'};
  let openedReference=null;
  referenceWorkspace.openFile=async(entry,location)=>{openedReference={entry,location};};
  referenceWorkspace.api.request=async()=>JSON.stringify({path:'/home/tester/memory.md',kind:'markdown'});
  await referenceWorkspace.openFileReference('~/memory.md','#L40');
  assert.equal(openedReference.entry.path,'/home/tester/memory.md');assert.equal(openedReference.location,'#L40');
  referenceWorkspace.api.request=async(url,method,body)=>{
    assert.equal(JSON.parse(body).path_token,rawIdentity);
    return JSON.stringify({path:'/raw-display/file.py',api_path:rawIdentity,kind:'text'});
  };
  await referenceWorkspace.openFileReference(rawLink.path,rawLink.location,()=>{},rawLink.apiPath);
  assert.equal(openedReference.entry.api_path,rawIdentity);assert.equal(openedReference.location,'#L40');
  let openedDirectory='';referenceWorkspace.api.request=async()=>JSON.stringify({path:'/home/tester/dir',kind:'directory'});
  await referenceWorkspace.openFileReference('~/dir','',path=>openedDirectory=path);
  assert.equal(openedDirectory,'/home/tester/dir');
  openedReference=null;referenceWorkspace.api.request=async()=>{referenceWorkspace.clearConnection();return JSON.stringify({path:'/stale'});};
  await referenceWorkspace.openFileReference('stale.md');assert.equal(openedReference,null);
  assert.equal(resolveCitationLink('docs/readme.md','example.py:40'),'docs/example.py:40');
  assert.equal(inlineParts('[file](example.py:40)')[0].url,'example.py:40');

  // Literal search crosses syntax runs and line boundaries without losing code.
  const searchCode='const answer = "中文😀";\nconst another = 42;';
  const searchLines=codeLines(searchCode,'javascript','answer = "中文😀"');
  assert.equal(searchLines.map(line=>line.tokens.map(token=>token.text).join('')).join('\n'),searchCode);
  assert.equal(searchLines.flatMap(line=>line.tokens.filter(token=>token.highlight)).map(token=>token.text).join(''),'answer = "中文😀"');
  assert.ok(searchLines.flatMap(line=>line.tokens).some(token=>token.highlight&&token.kind==='string'));
  assert.equal(codeLines('foo.bar fooXbar','text','foo.bar')[0].tokens.filter(token=>token.highlight).map(token=>token.text).join(''),'foo.bar');
  const across=codeLines('ONE\ntwo','text','one\ntwo');
  assert.equal(across.flatMap(line=>line.tokens.filter(token=>token.highlight)).map(token=>token.text).join(''),'ONEtwo');

  // View identities survive tab switches but cannot contaminate a later login.
  const viewWorkspace=new Workspace();
  viewWorkspace.selected={session_id:'a'};
  viewWorkspace.activeFile={path:'a.txt'};
  const viewA=viewWorkspace.fileViewState();viewA.cursor=32;viewA.query='needle';viewA.sourceY=250;
  viewWorkspace.activeFile={path:'b.txt'};
  assert.equal(viewWorkspace.fileViewState().cursor,0);
  viewWorkspace.activeFile={path:'a.txt'};
  assert.equal(viewWorkspace.fileViewState(),viewA);
  viewWorkspace.selected={session_id:'b'};
  assert.notEqual(viewWorkspace.fileViewState(),viewA);
  viewWorkspace.clearConnection();viewA.cursor=99;
  viewWorkspace.selected={session_id:'a'};viewWorkspace.activeFile={path:'a.txt'};
  assert.equal(viewWorkspace.fileViewState().cursor,0);
  // Large buffers and UTF-16 edits must round-trip without retaining whole snapshots.
  const typedHistory=new EditHistory();typedHistory.reset('');
  for(const text of ['a','ab','abc'])typedHistory.change(text,true);
  assert.equal(typedHistory.undo(),'');assert.equal(typedHistory.redo(),'abc');
  typedHistory.change('ab',true);typedHistory.change('a',true);
  assert.equal(typedHistory.undo(),'abc');assert.equal(typedHistory.redo(),'a');
  typedHistory.change('b',true);assert.equal(typedHistory.undo(),'a','Replacing is a separate edit');
  const largeHistory=new EditHistory();
  const largeBase='a'.repeat(1000000)+'中文 😀 tail';
  largeHistory.reset(largeBase);
  const largeVersions=[largeBase,largeBase.replace('😀','😃'),largeBase.replace('😀','😃').replace('tail','TAIL'), 'replaced entirely', ''];
  for(const text of largeVersions.slice(1))largeHistory.change(text);
  for(let i=largeVersions.length-2;i>=0;i--)assert.equal(largeHistory.undo(),largeVersions[i]);
  for(const text of largeVersions.slice(1))assert.equal(largeHistory.redo(),text);
  largeHistory.undo();largeHistory.change('new branch');assert.equal(largeHistory.redo(),'new branch');
  const boundaryBase=('x'.repeat(4095)+'😀中文\n').repeat(300);
  for(const offset of [0,1,4094,4095,4096,4097,8191,8192,600001,boundaryBase.length-1,boundaryBase.length]) {
    const versions=[boundaryBase];
    versions.push(boundaryBase.slice(0,offset)+'新增😀'+boundaryBase.slice(offset));
    versions.push(versions[1].slice(0,offset)+'\n'+versions[1].slice(offset+5));
    versions.push(versions[2].slice(0,offset)+versions[2].slice(offset+1));
    largeHistory.reset(versions[0]);
    for(const value of versions.slice(1))largeHistory.change(value);
    for(let i=versions.length-2;i>=0;i--)assert.equal(largeHistory.undo(),versions[i]);
    for(const value of versions.slice(1))assert.equal(largeHistory.redo(),value);
  }
  const {applyNativeStyle}=load(path.join(root,'model/NativeStyle.ets'));
  const {palette}=load(path.join(root,'model/Theme.ets'));
  const style=(css,dark=false,width=400)=>applyNativeStyle(css,palette('clay',dark),width);
  assert.equal(JSON.stringify(style('').palette),JSON.stringify(palette('clay',false)));
  assert.equal(style(':root { --paper:#123456; }').palette.assistantBubble,'#123456');
  assert.equal(style(':root { --accent:#123 !important; } body { --accent:#fff !important; } :root { --accent:#000; }').palette.accent,'#112233');
  assert.equal(style(':root { --accent:var(--custom); --custom:#abcd; }').palette.accent,'#ddaabbcc');
  assert.equal(style(':root { --accent:rgba(1,2,3,0.5); }').palette.accent,'#80010203');
  assert.equal(style(':root { --radius-control:14px; }').palette.radius,14);
  assert.equal(style(':root[data-mode="dark"] { --accent:#123; }',true).palette.accent,'#112233');
  assert.notEqual(style(':root[data-mode="dark"] { --accent:#123; }').palette.accent,'#112233');
  assert.equal(style('@media (min-width:600px) { :root { --accent:#123; } }',false,800).palette.accent,'#112233');
  assert.notEqual(style('@media (min-width:600px) { :root { --accent:#123; } }').palette.accent,'#112233');
  assert.equal(style('@media (prefers-color-scheme: dark) { :root { --accent:#123; } }',true).palette.accent,'#112233');
  assert.equal(style(':root { --accent:var(--missing,#abc); }').palette.accent,'#aabbcc');
  assert.ok(style(':root { --accent:var(--a); --a:var(--accent); }').warnings.length);
  assert.equal(style(':root { --accent:var(--missing,var(--also-missing,#abc)); }').palette.accent,'#aabbcc');
  assert.ok(style('.unknown { color:red; }').warnings.length);
  const components=style('.msg { background:#abc; padding:8px 12px; font-size:18px; } .msg.user { background:#123; border-radius:4px; }').components;
  assert.equal(components.user.background,'#112233');assert.equal(components.assistant.background,'#aabbcc');
  assert.equal(components.user.paddingLeft,12);assert.equal(components.user.paddingBottom,8);assert.equal(components.user.fontSize,18);
  assert.equal(style('.msg { padding-left:20px !important; padding:4px; }').components.user.paddingLeft,20);
  const variablePadding=style(':root { --pad: 7px 13px 19px; } .msg { padding:var(--pad); padding-left:21px; }');
  assert.equal(variablePadding.warnings.length,0);
  assert.equal(variablePadding.components.user.paddingTop,7);assert.equal(variablePadding.components.user.paddingRight,13);
  assert.equal(variablePadding.components.user.paddingBottom,19);assert.equal(variablePadding.components.user.paddingLeft,21);
  const scopedPadding=style('.msg { --pad:9px; padding:var(--missing, var(--pad)); } .msg.user { --pad:11px 15px; }');
  assert.equal(scopedPadding.components.user.paddingTop,11);assert.equal(scopedPadding.components.user.paddingRight,15);
  assert.equal(scopedPadding.components.assistant.paddingTop,9);
  assert.equal(style('.msg { padding-left:20px !important; padding:var(--pad); --pad:4px; }').components.user.paddingLeft,20);

  assert.equal(style('.msg.user { background:red; } .msg { background-color:blue; }').components.user.background,'red');
  assert.equal(style(':root[data-mode="dark"] .msg.assistant { color:#123; }',true).components.assistant.color,'#112233');
  assert.equal(style('.msg.user { --own:#123; color:var(--own); }').components.user.color,'#112233');

  assert.ok(style('@media print { :root { --accent:red; } }').warnings.length);
  const {fileLink,fileLocation}=load(path.join(root,'model/FileLinks.ets'));
  assert.equal(fileLink('docs/guide.md','../image.png'),'image.png');
  assert.equal(fileLink('/project/docs/guide.md','image.png'),'/project/docs/image.png');
  assert.equal(fileLink('README.md','https://example.com/image.png'),'https://example.com/image.png');
  assert.equal(fileLink('docs/a.md','#section'),'#section');
  assert.equal(fileLocation('docs/a.ts#L12-L15').path,'docs/a.ts');
  assert.equal(fileLocation('docs/a.ts:12:4').location,'#L12');
  assert.equal(fileLocation('#section').path,'');
  assert.equal(markdownBlocks('# Hello **World**!\n\n# Hello World!\n\n# 中文 标题').filter(b=>b.kind==='heading').map(b=>b.anchor).join(','),'hello-world,hello-world-1,中文-标题');
  const {LaunchContext} = load(path.join(root,'model/LaunchContext.ets'));
  const launchContext = new LaunchContext(); let finishOld;
  const launchApi = {connectionVersion:()=>1,request:async p=>p.includes('old') ? await new Promise(r=>{finishOld=r;}) : JSON.stringify({git_repo:true,sessions:[{session_id:'new'}]})};
  const oldLaunch=launchContext.load(launchApi,'/old','pi');await launchContext.load(launchApi,'/new','codex');finishOld(JSON.stringify({sessions:[{session_id:'old'}]}));await oldLaunch;
  assert.equal(launchContext.candidates[0].session_id,'new');assert.equal(launchContext.info.git_repo,true);
  const cancelled=launchContext.load(launchApi,'/old','pi');launchContext.cancel();finishOld(JSON.stringify({sessions:[{session_id:'cancelled'}]}));await cancelled;assert.equal(launchContext.candidates.length,0);

  const directoryApi={connectionVersion:()=>1,request:async()=>JSON.stringify({directories:[{name:'native-one',path:'/home/native-one'},{name:'other',path:'/home/other'}]})};
  await launchContext.suggest(directoryApi,'/home/nat',['/home/native-one','/tmp/recent']);
  assert.equal(launchContext.directories.length,1);assert.equal(launchContext.directories[0].path,'/home/native-one');
  launchContext.info={git_repo:true};launchContext.cancel();assert.equal(launchContext.info.git_repo,undefined);

  const {moveCursor,editAtCursor} = load(path.join(root,'model/EditorMotion.ets'));
  assert.equal(moveCursor('a😀b',1,'l'),3); assert.equal(moveCursor('a😀b',3,'h'),1);
  assert.equal(editAtCursor('a😀b',1,'x').text,'ab');
  assert.equal(moveCursor('a😀b\nx😀z',3,'j'),8);
  assert.equal(moveCursor('one, two',0,'w'),3); assert.equal(moveCursor('one, two',4,'w'),5);
  assert.equal(moveCursor('one, two',8,'b'),5); assert.equal(moveCursor('one, two',0,'e'),2);
  for (const [text,cursor,want] of [['one\ntwo\nthree',5,'one\nthree'],['one\ntwo',5,'one'],['only',2,''],['one\n',4,'one']]) assert.equal(editAtCursor(text,cursor,'dd').text,want);
  assert.equal(editAtCursor('one\ntwo',1,'o').text,'one\n\ntwo');
  assert.equal(editAtCursor('one\ntwo',5,'O').cursor,4);

  const {highlightedParts} = load(path.join(root,'model/Markdown.ets'));
  const marked = highlightedParts(inlineParts('Alpha **beta** gamma [delta](file.txt)'), 'HA BETA GA');
  assert.equal(marked.map(p => p.text).join(''),'Alpha beta gamma delta');
  assert.equal(marked.filter(p => p.highlight).map(p => p.text).join(''),'ha beta ga');
  assert.ok(marked.find(p => p.text === 'beta').bold);
  assert.equal(marked.find(p => p.text === 'delta').url,'file.txt');
  assert.equal(highlightedParts(inlineParts('a+b a+b'), 'a+b').filter(p => p.highlight).length,2);
  const mathParts = inlineParts('Energy $E=mc^2$ and $x^2$.');
  const mathMatch = highlightedParts(mathParts, 'mc^2');
  assert.equal(mathMatch.find(p => p.math === 'E=mc^2').highlight, true);
  assert.equal(mathMatch.find(p => p.math === 'x^2').highlight, false);
  assert.equal(mathMatch.filter(p => p.math).length, 2, 'Partial search never splits TeX');
  assert.equal(mathParts.some(p => p.highlight), false, 'Search cannot mutate the parsed cache');
  assert.equal(highlightedParts(mathParts, '').some(p => p.highlight), false);
  const crossingMath = highlightedParts(inlineParts('before $x^2$ after'), 'before x');
  assert.equal(crossingMath.find(p => p.math).highlight, true);
  assert.equal(crossingMath.filter(p => p.highlight && !p.math).map(p => p.text).join(''), 'before ');

  const {customSnooze} = load(path.join(root,'model/SessionPresentation.ets'));
  assert.equal(new Date(customSnooze('2028-02-29','09:30') * 1000).getDate(),29);
  for (const [date,time] of [['2027-02-29','09:30'],['2028-04-31','09:30'],['2028-01-01','24:01'],['2028-01-01','09:60'],['','']]) assert.throws(() => customSnooze(date,time), /valid snooze/);
  const {rememberLaunch} = load(path.join(root,'model/Preferences.ets'));
  let choices = [];
  for (const choice of [{server:'A',backend:'pi',provider:'first',model:'one'},{server:'B',backend:'pi',provider:'second',model:'two'},{server:'A',backend:'codex',provider:'chatgpt',model:'three'},{server:'A',backend:'pi',provider:'updated',model:'four'}]) choices = rememberLaunch(choices,choice);
  assert.equal(choices.length,3); assert.equal(choices[0].model,'four');
  assert.equal(choices.find(c => c.server === 'B').provider,'second');
  assert.equal(choices.find(c => c.backend === 'codex').provider,'chatgpt');

  const io = kits['@kit.CoreFileKit'].fileIo;
  // Independent durable buffers: migration, short writes, atomic failures,
  // Unicode restart recovery and write cost independent of unrelated buffers.
  const {FileDrafts}=load(path.join(root,'services/FileDrafts.ets'));
  const draftDirectory=fs.mkdtempSync('/tmp/codoxear-native-drafts-');
  let writtenBytes=0, failDraftRename=false;
  kits['@kit.ArkTS'].util.TextEncoder=class {encodeInto(value){return new TextEncoder().encode(value);}};
  Object.assign(io,{
    OpenMode:{CREATE:1,WRITE_ONLY:2,TRUNC:4},
    accessSync:filename=>fs.existsSync(filename),readTextSync:filename=>fs.readFileSync(filename,'utf8'),
    openSync:filename=>({fd:fs.openSync(filename,'w')}),closeSync:file=>fs.closeSync(file.fd),
    writeSync:(fd,buffer)=>{const chunk=Buffer.from(buffer).subarray(0,32767);writtenBytes+=chunk.length;return fs.writeSync(fd,chunk);},
    renameSync:(from,to)=>{if(failDraftRename && /file-draft-\d/.test(to))throw new Error('disk unavailable');fs.renameSync(from,to);},
    unlinkSync:filename=>fs.unlinkSync(filename)
  });
  try {
    const small={server:'A',session:'S',key:'small',base:{path:'small',version:'original',text:'base'},text:'old 中文'};
    const large={server:'A',session:'S',key:'large',base:{path:'large',version:'v2',text:'x'.repeat(1200000)},text:'y'.repeat(1200000)};
    fs.writeFileSync(path.join(draftDirectory,'file-drafts.json'),JSON.stringify([small,large]));
    const drafts=new FileDrafts();assert.equal(drafts.get(draftDirectory,'A','S','small').text,small.text);
    drafts.put(draftDirectory,{...small,text:'migrated 中文 😀'},true);
    assert.equal(fs.existsSync(path.join(draftDirectory,'file-drafts.json')),false);
    writtenBytes=0;
    drafts.put(draftDirectory,{...small,text:'next 中文 😀'},true);
    assert.ok(writtenBytes<500,'Typing in a small buffer must not rewrite the unrelated 2.4MB buffer');
    const cost=writtenBytes;drafts.put(draftDirectory,{...small,text:'next 中文 😀'},true);assert.equal(writtenBytes,cost,'Unchanged tab stashing must not write');
    let recovered=new FileDrafts();assert.equal(recovered.get(draftDirectory,'A','S','small').text,'next 中文 😀');assert.equal(recovered.get(draftDirectory,'A','S','large').text,large.text);
    failDraftRename=true;assert.throws(()=>drafts.put(draftDirectory,{...small,text:'failed update'},true),/disk unavailable/);failDraftRename=false;
    recovered=new FileDrafts();assert.equal(recovered.get(draftDirectory,'A','S','small').text,'next 中文 😀','Failed replacement keeps the previous durable buffer');
    drafts.put(draftDirectory,small,false);recovered=new FileDrafts();assert.equal(recovered.get(draftDirectory,'A','S','small'),undefined);assert.equal(recovered.list(draftDirectory,'A','S').length,1);
    assert.equal(recovered.list(draftDirectory,'different','S').length,0);
  } finally {fs.rmSync(draftDirectory,{recursive:true,force:true});}
  io.OpenMode = {READ_ONLY: 1};
  let closedFiles = 0, readCalls = 0;
  io.open = async () => ({fd: 7}); io.close = async () => { closedFiles++; };
  io.stat = async () => ({size: 5});
  io.read = async (fd, buffer) => {
    const chunk = readCalls++ === 0 ? [1, 2] : [3, 4, 5];
    new Uint8Array(buffer).set(chunk); return chunk.length;
  };
  kits['@kit.CoreFileKit'].fileUri = {FileUri: class {get name() {return 'provider-photo.png';}}};
  const {readAttachment} = load(path.join(root,'services/AttachmentFile.ets'));
  const attachment = await readAttachment('file://provider/photo', () => true);
  assert.deepEqual(Array.from(attachment.bytes),[1,2,3,4,5]);
  assert.equal(attachment.name,'provider-photo.png'); assert.equal(closedFiles,1);
  io.read = async () => 0;
  await assert.rejects(readAttachment('file://truncated', () => true), /changed while being read/);
  await assert.rejects(readAttachment('file://cancelled', () => false), /selection changed/);
  assert.equal(closedFiles,3, 'Files close on short reads and cancellation');
  io.stat = async () => ({size: 17*1024*1024});
  await assert.rejects(readAttachment('file://too-big', () => true), /exceeds/);
  assert.equal(closedFiles,4);
  let finishRead;
  io.stat = async () => ({size: 1});
  io.read = (fd, buffer) => new Promise(resolve => {finishRead = () => {new Uint8Array(buffer)[0]=42;resolve(1);};});
  kits['@kit.ArkTS'].util.Base64Helper = class {encodeToStringSync(bytes) {return Buffer.from(bytes).toString('base64');}};
  const uploading = new Workspace(); uploading.selected={session_id:'photo'}; uploading.draft='Hold until photo arrives';
  let uploadCalls=0;
  uploading.api={request:async () => {uploadCalls++;return '{}';}};
  const upload = uploading.upload('file://pending');
  for(let i=0;i<10;i++) await Promise.resolve();
  assert.equal(uploading.uploading,true);
  await uploading.send(); assert.equal(uploadCalls,0); assert.match(uploading.error,/upload to finish/);
  finishRead(); await upload; assert.equal(uploading.uploading,false);assert.equal(uploadCalls,2);
  const cancelledUpload=uploading.upload('file://pending');
  for(let i=0;i<10;i++) await Promise.resolve();
  uploading.epoch++; uploading.selected={session_id:'other'};
  finishRead();await cancelledUpload;assert.equal(uploadCalls,2,'Switching session before bytes are read must not upload');
  assert.equal(uploading.uploading,false);

  io.read = async (fd,buffer) => {new Uint8Array(buffer)[0]=42;return 1;};
  let rejectUpload;
  const lateUpload=new Workspace();lateUpload.selected={session_id:'first'};
  lateUpload.api={request:()=>new Promise((resolve,reject)=>{rejectUpload=reject;})};
  const lateFailure=lateUpload.upload('file://photo');
  for(let i=0;i<15;i++)await Promise.resolve();
  lateUpload.epoch++;lateUpload.selected={session_id:'second'};
  rejectUpload(new Error('Old session upload failed'));
  await assert.doesNotReject(lateFailure,'Old upload failure must not surface in a different session');
  assert.equal(lateUpload.uploading,false);
  const committedAttachment={id:'committed',display_name:'provider-photo.png',size:1};
  const lostUpload=new Workspace();lostUpload.selected={session_id:'photo'};lostUpload.draft='preserve me';
  lostUpload.api={request:async path=>{
    if(path.endsWith('/inject_file'))throw new Error('Acknowledgement lost');
    return JSON.stringify({attachments:[committedAttachment]});
  }};
  await assert.rejects(lostUpload.upload('file://photo'),/Acknowledgement lost/);
  assert.equal(JSON.stringify(lostUpload.attachments),JSON.stringify([committedAttachment]),'Reconcile server staging after lost acknowledgement');
  assert.equal(lostUpload.draft,'preserve me');assert.equal(lostUpload.uploading,false);
  const attachedSend=new Workspace();attachedSend.selected={session_id:'attached',pending_attachment:true};
  attachedSend.attachments=[committedAttachment];attachedSend.setDraft('Keep attachment until confirmed');
  let sendBodies=[], rejectInjection=true;
  attachedSend.api={request:async (path,method,body)=>{
    if(path.endsWith('/send')) {
      sendBodies.push(JSON.parse(body));
      if(rejectInjection)throw Object.assign(new Error('Attachment injection rejected'),{status:502});
      return '{}';
    }
    if(path==='/api/sessions')return JSON.stringify({sessions:[{session_id:'attached',pending_attachment:true,staged_attachments:[committedAttachment]}]});
    return '{}';
  }};
  await attachedSend.send();
  assert.equal(sendBodies[0].allow_pending_attachment,true);
  assert.equal(attachedSend.draft,'Keep attachment until confirmed');assert.equal(attachedSend.attachments.length,1);
  assert.equal(attachedSend.unknownSend(),false);assert.match(attachedSend.error,/injection rejected/);
  await attachedSend.send(true);assert.equal(sendBodies.length,1);assert.match(attachedSend.error,/before adding/);
  rejectInjection=false;await attachedSend.send();
  assert.equal(sendBodies.length,2);assert.equal(attachedSend.draft,'');assert.equal(attachedSend.attachments.length,0);
  const legacyAttachment=new Workspace();legacyAttachment.selected={session_id:'legacy',pending_attachment:true};legacyAttachment.setDraft('Explicit pending send');
  let legacyBody;
  legacyAttachment.api={request:async (path,method,body)=>{if(path.endsWith('/send'))legacyBody=JSON.parse(body);return '{}';}};
  assert.equal(legacyAttachment.needsAttachmentConfirmation(),true);
  await legacyAttachment.send();assert.equal(legacyBody,undefined);assert.equal(legacyAttachment.draft,'Explicit pending send');
  await legacyAttachment.send(false,true);assert.equal(legacyBody.allow_pending_attachment,true);assert.equal(legacyAttachment.draft,'');
  const reconciled=new Workspace();reconciled.selected={session_id:'photo'};
  let finishCatalog,finishAttachments;
  reconciled.api={request:path=>new Promise(resolve=>{
    if(path==='/api/sessions')finishCatalog=resolve;else finishAttachments=resolve;
  })};
  const oldCatalog=reconciled.refresh();const newAttachments=reconciled.loadAttachments();
  finishAttachments(JSON.stringify({attachments:[committedAttachment]}));await newAttachments;
  finishCatalog(JSON.stringify({sessions:[{session_id:'photo',staged_attachments:[]}]}));await oldCatalog;
  assert.equal(JSON.stringify(reconciled.attachments),JSON.stringify([committedAttachment]),'Old catalog cannot erase newer attachment results');
  const oldAttachments=reconciled.loadAttachments();const newCatalog=reconciled.refresh();
  finishCatalog(JSON.stringify({sessions:[{session_id:'photo',staged_attachments:[]}]}));await newCatalog;
  finishAttachments(JSON.stringify({attachments:[committedAttachment]}));await oldAttachments;
  assert.equal(JSON.stringify(reconciled.attachments),'[]','Old attachment read cannot restore removed server staging');
  lostUpload.api={request:async()=>{throw new Error('Offline');}};
  await assert.rejects(lostUpload.upload('file://photo'),/Offline/);
  lostUpload.api={request:async()=>JSON.stringify({sessions:[{session_id:'photo',staged_attachments:[committedAttachment]}]})};
  await lostUpload.refresh();assert.equal(JSON.stringify(lostUpload.attachments),JSON.stringify([committedAttachment]),'Reconnect recovers server staging');

  // A save picker may outlive the authenticated connection that opened it.
  const {exportFile}=load(path.join(root,'services/FileExport.ets'));
  let finishPicker, downloads=0, version=1;
  kits['@kit.CoreFileKit'].picker={DocumentViewPicker:class {save(){return new Promise(resolve=>{finishPicker=resolve;});}}};
  kits['@kit.BasicServicesKit'].request.downloadFile=async()=>{downloads++;};
  const exportApi={connectionVersion:()=>version, requireConnection:v=>{if(v!==version)throw new Error('Connection changed');},address:()=> 'http://fixture/api/file',authHeaders:()=>({Cookie:'fixture'})};
  const staleExport=exportFile({cacheDir:'/cache'},exportApi,'/api/file','fixture.txt');
  const exportRejected=assert.rejects(staleExport,/Connection changed/);
  version++;finishPicker(['file://destination']);await exportRejected;
  assert.equal(downloads,0,'Do not download against a connection changed during the picker');
  const launcher=new Workspace();launcher.panel='new';
  let launches=0, rows=[], finishLaunch, selectedLaunch='', renamedLaunch='';
  launcher.api={request:async(url,method,body)=>{if(url.endsWith('/rename')){renamedLaunch=JSON.parse(body).name;return '{}';}if(url==='/api/sessions' && launches===0){launches++;return new Promise(resolve=>{finishLaunch=resolve;});}return JSON.stringify({sessions:rows});}};
  launcher.select=async row=>{selectedLaunch=row.session_id;launcher.epoch++;};
  const launchWork=launcher.create({cwd:'/fixture',name:'Native named session'});
  await launcher.create({cwd:'/fixture'});assert.equal(launches,1,'Repeated create cannot launch twice');
  finishLaunch('{"broker_pid":901}');await launchWork;assert.equal(launcher.creating,false);assert.equal(selectedLaunch,'');
  rows=[{session_id:'ready',broker_pid:901}];await launcher.refresh();assert.equal(renamedLaunch,'Native named session');assert.equal(selectedLaunch,'ready','Select the broker returned by a successful launch when its log appears');
  launcher.api={request:async(url,method)=>method==='POST' ? '{"pending":true,"launch_id":"pending-id"}' : JSON.stringify({sessions:rows})};
  rows=[{session_id:'starting',launch_id:'pending-id',launch_state:'starting'}];await launcher.create({cwd:'/fixture'});
  assert.equal(selectedLaunch,'ready','Do not select a placeholder launch row');
  rows=[{session_id:'arrived',launch_id:'pending-id'}];launcher.epoch++;await launcher.refresh();
  assert.equal(selectedLaunch,'ready','A later selection cancels launch auto-navigation');

  const rawFiles=new Workspace();rawFiles.selected={session_id:'raw-file-session'};
  const rawFileCalls=[];
  rawFiles.api.request=async(url,method,body)=>{
    rawFileCalls.push({url,body:body?JSON.parse(body):null});
    if(url.endsWith('/api/files/inspect'))return JSON.stringify({path:'/repo/raw-display/file.py',api_path:rawIdentity,kind:'text'});
    if(url.includes('/file/search?'))return JSON.stringify({mode:'git',matches:[{path:'raw-display/file.py',api_path:'relative-token'}]});
    return JSON.stringify({path:'/repo/raw-display/file.py',rel:'/repo/raw-display/file.py',api_path:rawIdentity,text:'original',kind:'text',editable:true,version:'v1'});
  };
  await rawFiles.loadFiles('file.py');await rawFiles.openFile(rawFiles.files[0]);
  assert.equal(new URL('http://test'+rawFileCalls[1].url).searchParams.get('path_token'),'relative-token');
  assert.equal(new URL('http://test'+rawFileCalls[1].url).searchParams.get('git_path'),null,'Search mode describes discovery, not a repository-root path');
  assert.equal(rawFiles.activeFile.path_token,rawIdentity);assert.equal(rawFiles.fileKey(rawFiles.activeFile),rawIdentity);
  rawFiles.changeFile('updated');await rawFiles.saveFile();
  assert.equal(rawFileCalls.at(-1).body.path_token,rawIdentity);
  await rawFiles.reloadFile();assert.equal(new URL('http://test'+rawFileCalls.at(-1).url).searchParams.get('path_token'),rawIdentity);
  assert.equal(new URL('http://test'+rawFiles.fileDownloadPath()).searchParams.get('path_token'),rawIdentity);
  const fileTabs=new Workspace();fileTabs.selected={session_id:'file-session'};
  fileTabs.api={request:async p=>JSON.stringify({path:p.includes('second')?'second.txt':'first.txt',rel:p.includes('second')?'second.txt':'first.txt',text:'original',kind:'text',editable:true,version:'1'})};
  await fileTabs.openFile({path:'first.txt'},'#L5');assert.equal(fileTabs.fileLocation,'#L5');fileTabs.fileHistory().change('unsaved first');fileTabs.fileText='unsaved first';fileTabs.fileDirty=true;
  await fileTabs.openFile({path:'second.txt'});fileTabs.fileText='unsaved second';fileTabs.fileDirty=true;
  fileTabs.switchFile('first.txt');assert.equal(fileTabs.fileText,'unsaved first');assert.equal(fileTabs.fileDirty,true);
  assert.equal(fileTabs.fileHistory().undo(),'original');assert.equal(fileTabs.fileHistory().redo(),'unsaved first');
  fileTabs.closeFile('first.txt');assert.equal(fileTabs.fileText,'unsaved second');assert.equal(fileTabs.fileTabs.length,1);
  let finishReload;fileTabs.api.request=()=>new Promise(r=>{finishReload=r;});
  const reloading=fileTabs.reloadFile();fileTabs.fileText='typed during reload';
  finishReload(JSON.stringify({path:'second.txt',rel:'second.txt',text:'server',kind:'text'}));
  await assert.rejects(reloading,/changed while reloading/);assert.equal(fileTabs.fileText,'typed during reload');
  fileTabs.api.request=async()=>JSON.stringify({path:'second.txt',rel:'second.txt',text:'server',kind:'text',editable:true});
  fileTabs.fileHistory().change('pre-reload change');
  await fileTabs.reloadFile();assert.equal(fileTabs.fileHistory().undo(),'server');assert.equal(fileTabs.fileText,'server');assert.equal(fileTabs.fileDirty,false);
  fileTabs.fileText='submitted';fileTabs.fileDirty=true;let finishTabbedSave;
  fileTabs.api.request=()=>new Promise(r=>{finishTabbedSave=r;});const tabbedSaving=fileTabs.saveFile();
  fileTabs.stashFile();fileTabs.activeFile={path:'third.txt',rel:'third.txt',text:'three',kind:'text',editable:true};fileTabs.fileText='three';fileTabs.fileDirty=false;fileTabs.stashFile();
  finishTabbedSave(JSON.stringify({version:'2'}));await tabbedSaving;
  fileTabs.switchFile('second.txt');assert.equal(fileTabs.fileText,'submitted');assert.equal(fileTabs.fileDirty,false);assert.equal(fileTabs.activeFile.version,'2');

  const savedIo={...io}, persisted=new Map();let nextFd=30;const openFiles=new Map();
  io.openSync=(file)=>{openFiles.set(++nextFd,file);persisted.set(file,'');return {fd:nextFd};};
  io.closeSync=()=>{};io.writeSync=(fd,buffer)=>{const text=Buffer.from(buffer).toString('utf8');persisted.set(openFiles.get(fd),persisted.get(openFiles.get(fd))+text);return buffer.byteLength;};io.unlinkSync=file=>persisted.delete(file);
  io.renameSync=(from,to)=>{persisted.set(to,persisted.get(from));persisted.delete(from);};
  io.readTextSync=file=>{if(!persisted.has(file))throw new Error('missing');return persisted.get(file);};
  io.accessSync=file=>persisted.has(file);
  const persistentFiles=new Workspace();persistentFiles.storageDir='/state';persistentFiles.endpointKey='server-a';persistentFiles.selected={session_id:'file-draft'};
  const baseFile={path:'draft.txt',rel:'draft.txt',text:'base',kind:'text',editable:true,version:'v1'};
  persistentFiles.api={request:async()=>JSON.stringify(baseFile)};
  await persistentFiles.openFile({path:'draft.txt'});persistentFiles.changeFile('local change');
  const reopenedFiles=new Workspace();reopenedFiles.storageDir='/state';reopenedFiles.endpointKey='server-a';reopenedFiles.selected={session_id:'file-draft'};
  reopenedFiles.api={request:async()=>JSON.stringify({...baseFile,text:'changed remotely',version:'v2'})};
  await reopenedFiles.openFile({path:'draft.txt'});assert.equal(reopenedFiles.fileText,'local change');assert.equal(reopenedFiles.activeFile.version,'v1','Recovery retains the original conflict token');assert.equal(reopenedFiles.fileDirty,true);
  const otherServer=new Workspace();otherServer.storageDir='/state';otherServer.endpointKey='server-b';otherServer.selected={session_id:'file-draft'};otherServer.api=persistentFiles.api;
  await otherServer.openFile({path:'draft.txt'});assert.equal(otherServer.fileText,'base','A different server cannot receive the recovered buffer');
  reopenedFiles.authenticated=true;reopenedFiles.refreshRecovery();
  assert.equal(reopenedFiles.recoveryFiles.length,1);
  const recoveryEntry=reopenedFiles.recoveryFiles[0];
  otherServer.authenticated=true;otherServer.refreshRecovery();assert.equal(otherServer.recoveryFiles.length,0);
  otherServer.recoverFile(recoveryEntry);assert.equal(otherServer.fileText,'base');
  reopenedFiles.changeFile('latest buffer');
  reopenedFiles.recoverFile(recoveryEntry);assert.equal(reopenedFiles.fileText,'latest buffer','Stale recovery row must load current draft');
  reopenedFiles.discardFile();reopenedFiles.refreshRecovery();assert.equal(reopenedFiles.recoveryFiles.length,0);
  const discardedFiles=new Workspace();discardedFiles.storageDir='/state';discardedFiles.endpointKey='server-a';discardedFiles.selected={session_id:'file-draft'};discardedFiles.api=persistentFiles.api;
  await discardedFiles.openFile({path:'draft.txt'});assert.equal(discardedFiles.fileDirty,false);assert.equal(discardedFiles.fileText,'base');
  const uncertain=new Workspace();uncertain.storageDir='/state';uncertain.selected={session_id:'lost-ack'};
  uncertain.setDraft('send exactly once');let posted=0;
  uncertain.api={request:async(url,method)=>{if(method==='POST'){posted++;throw new Error('response lost');}return '{"sessions":[{"session_id":"lost-ack"}]}';}};
  await uncertain.send();assert.equal(posted,1);assert.equal(uncertain.unknownSend(),true);
  const resumed=new Workspace();resumed.storageDir='/state';resumed.selected={session_id:'lost-ack'};
  resumed.restoreDraft('lost-ack');resumed.draft=resumed.drafts.get('lost-ack');
  assert.equal(resumed.unknownSend(),true,'An uncertain send survives process restart');assert.equal(resumed.draft,'send exactly once');
  resumed.api={request:async()=>{posted++;return '{"sessions":[]}';}};
  await resumed.send();assert.equal(posted,1,'Restart must not permit automatic or accidental duplicate submission');
  await resumed.clearUnknownSend();assert.equal(resumed.unknownSend(),false);
  const cleared=new Workspace();cleared.storageDir='/state';cleared.selected={session_id:'lost-ack'};cleared.restoreDraft('lost-ack');assert.equal(cleared.unknownSend(),false);
  // Draft timestamp and clean baseline survive restart; a server tombstone
  // wins over cached text, while an unchanged server preserves offline typing.
  const draftDisk=new Workspace();draftDisk.storageDir='/state';draftDisk.endpointKey='draft-server';draftDisk.selected={session_id:'shared'};
  draftDisk.rememberDraft('shared','baseline');draftDisk.acknowledgeDraft('shared','baseline',10);
  draftDisk.rememberDraft('shared','offline edit');
  const draftRestart=new Workspace();draftRestart.storageDir='/state';draftRestart.endpointKey='draft-server';draftRestart.selected={session_id:'shared'};
  draftRestart.restoreDraft('shared');draftRestart.draft=draftRestart.drafts.get('shared');
  assert.equal(draftRestart.draft,'offline edit');assert.equal(draftRestart.draftStamps.get('shared'),10);
  draftRestart.api={request:async()=>JSON.stringify({text:'baseline',updated_ts:10})};
  await draftRestart.reconcileDraft('shared');assert.equal(draftRestart.draftPending.get('shared'),'offline edit');draftRestart.dispose();
  const draftRemote=new Workspace();draftRemote.storageDir='/state';draftRemote.endpointKey='draft-server';draftRemote.selected={session_id:'shared'};
  draftRemote.restoreDraft('shared');draftRemote.draft=draftRemote.drafts.get('shared');
  draftRemote.api={request:async()=>JSON.stringify({text:'',updated_ts:11})};await draftRemote.reconcileDraft('shared');
  assert.equal(draftRemote.draft,'');assert.equal(draftRemote.draftStamps.get('shared'),11);
  const deletedRestart=new Workspace();deletedRestart.storageDir='/state';deletedRestart.endpointKey='draft-server';deletedRestart.restoreDraft('shared');
  assert.equal(deletedRestart.drafts.get('shared'),'');assert.equal(deletedRestart.draftStamps.get('shared'),11);
  Object.assign(io,savedIo);

  const presentation = load(path.join(root,'model/SessionPresentation.ets'));
  assert.deepEqual(Array.from(presentation.sessionBadges({session_id:'one',lost:true,queue_len:2,unread_count:3,unattended_enabled:true})),['lost','unattended','queue 2','unread 3']);
  assert.equal(presentation.sessionGroup({session_id:'one',blocked:true,snoozed:true}),1,'Dependency waiting takes precedence over snooze');
  assert.equal(presentation.launchPending({session_id:'one',launch_state:'pending'}),true);
  const tomorrow = new Date(presentation.tomorrowMorning(new Date(2026,9,2,23,30).getTime())*1000);
  assert.equal(tomorrow.getDate(),3);assert.equal(tomorrow.getHours(),9);
  const duplicate=presentation.duplicateRequest({session_id:'one',cwd:'/fixture',agent_backend:'pi',model:'test',model_provider:'fixture',reasoning_effort:'low',service_tier:'fast',transport:'tmux'});
  assert.equal(duplicate.create_in_tmux,true);assert.equal(duplicate.resume_session_id,'');assert.equal(duplicate.service_tier,'fast');assert.equal(duplicate.reasoning_effort,'low');
  assert.throws(()=>presentation.duplicateRequest({session_id:'one',cwd:'/fixture',lost:true}),/Review/);
  assert.equal(codeLines('a\n\nb').map(line=>line.tokens.map(token=>token.text).join('')).join('\n'),'a\n\nb');
  const py=codeLines('x = """first\nsecond"""\n# done','sample.py');
  assert.equal(py[1].tokens[0].kind,'string');assert.equal(py[2].tokens[0].kind,'comment');
  const tsCode=codeLines('interface Person { name: string; }','src/main.ets');assert.ok(tsCode[0].tokens.find(t=>t.text==='interface'&&t.kind==='keyword'));
  const htmlCode=codeLines('<script>const n = 42;</script>','html');assert.ok(htmlCode[0].tokens.find(t=>t.text==='42'&&t.kind==='number'));
  for(const hint of ['python','js','rust','cpp','unknown']) {
    const source='a😀b\n\n"quoted"\n';const result=codeLines(source,hint);
    assert.equal(result.map(line=>line.text).join('\n'),source);
    assert.equal(result[1].offset,5);
  }


  const { Announcements } = load(path.join(root, 'services/Announcements.ets'));
  const staleSettings = new Announcements();
  let finishVoice; const requestedSettings = [];
  const settingsApi = {request: async (url) => {requestedSettings.push(url); return await new Promise(resolve => {finishVoice = resolve;});}};
  const loadSettings = staleSettings.load(settingsApi); staleSettings.dispose({request: async () => '{}'});
  finishVoice('{}'); await loadSettings; assert.equal(requestedSettings.length,1,'A disposed settings read must not start another request');
  requestedSettings.length = 0;
  const saveSettings = staleSettings.save(settingsApi,{},'old endpoint prompt'); staleSettings.dispose({request: async () => '{}'});
  finishVoice('{}'); await saveSettings; assert.equal(requestedSettings.length,1,'A disposed settings save must not write a prompt to a new connection');
  const announcements = new Announcements();
  const calls = [];
  let completeEnable;
  const audioApi = { request: async (url, method, body) => {
    const enabled = JSON.parse(body).enabled; calls.push(enabled);
    if (enabled) await new Promise(resolve => { completeEnable = resolve; });
    return '{}';
  } };
  const enable = announcements.setListening(audioApi, true);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  announcements.dispose(audioApi);
  completeEnable(); await enable;
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.deepEqual(calls, [true, false], 'Logout must finish with the server listener disabled even during enable');
  assert.equal(announcements.listening, false);
  await assert.rejects(announcements.setListening({request: async () => {throw new Error('offline');}}, true), /offline/);
  assert.equal(announcements.listening, false, 'Registration failure must roll back listening');
  let grantPermission;
  kits['@kit.NotificationKit'].notificationManager.requestEnableNotification = () => new Promise(resolve => {grantPermission = resolve;});
  let feedRequested = false;
  const pendingPermission = announcements.setNotifications({request: async () => {feedRequested = true;return '{"items":[]}';}}, true, {});
  announcements.dispose(audioApi); grantPermission(); await pendingPermission;
  assert.equal(announcements.notifications, false);
  assert.equal(feedRequested, false, 'Permission response after logout must not restart notifications');

  const routing=new Workspace();routing.authenticated=true;
  let routeReads=0, routeSelected='';
  routing.api={address:()=> 'http://first.test/api/me'};
  routing.refresh=async()=>{routeReads++;routing.sessions=[{session_id:'tap'}];};
  routing.select=async row=>{routeSelected=row.session_id;};
  assert.equal(await routing.openNotification('http://other.test/api/me','tap'),false);
  assert.equal(routeReads,0,'A notification from another endpoint must not read or select this connection');
  assert.equal(await routing.openNotification('http://first.test/api/me','tap'),true);assert.equal(routeSelected,'tap');
  await routing.openNotification('http://first.test/api/me','removed');assert.equal(routing.sidebar,true);
  assert.match(routing.notice,/no longer available/);

  const { conversationCopy, conversationCopyFailure } = load(path.join(root, 'model/ConversationCopy.ets'));
  const { ApiError, ApiClient } = load(path.join(root, 'services/ApiClient.ets'));
  // Delayed old endpoint responses must neither install cookies nor expire a new login.
  const pendingHttp = [];
  kits['@kit.NetworkKit'].http.HttpDataType = {STRING: 0, ARRAY_BUFFER: 1};
  kits['@kit.NetworkKit'].http.createHttp = () => ({
    request: (url, options) => new Promise(resolve => pendingHttp.push({url, options, resolve})), destroy: () => {}
  });
  const client = new ApiClient(); client.configure('http://first.test');
  const loginOld = client.login('one'); const oldRejected = assert.rejects(loginOld, /superseded/);
  client.configure('http://second.test');
  const loginNew = client.login('two');
  pendingHttp[1].resolve({responseCode:200,result:'{}',header:{'Set-Cookie':'codoxear_auth=new; HttpOnly'}}); await loginNew;
  pendingHttp[0].resolve({responseCode:200,result:'{}',header:{'Set-Cookie':'codoxear_auth=old; HttpOnly'}}); await oldRejected;
  assert.equal(client.authHeaders().Cookie,'codoxear_auth=new');
  let expired = 0; client.onUnauthorized = () => expired++;
  const oldRead = client.request('/api/sessions'); const oldReadRejected = assert.rejects(oldRead,/superseded/);
  client.configure('http://third.test');
  pendingHttp[2].resolve({responseCode:401,result:'{}',header:{}}); await oldReadRejected;
  assert.equal(expired,0,'An old endpoint 401 cannot expire a new connection');
  const currentRead = client.request('/api/sessions'); const currentRejected = assert.rejects(currentRead,error => error.status === 401);
  pendingHttp[3].resolve({responseCode:401,result:'{"error":"unauthorized"}',header:{}}); await currentRejected;
  assert.equal(expired,1); assert.equal(client.authHeaders().Cookie,'');
  await assert.rejects(client.request('/api/sessions'),/superseded/);

  const authWorkspace = new Workspace();
  authWorkspace.api.configure('http://before.test');
  authWorkspace.selected = {session_id:'same'}; authWorkspace.setDraft('old endpoint draft');
  let finishOldSend;
  authWorkspace.api.request = () => new Promise(resolve => {finishOldSend = resolve;});
  const sendingOld = authWorkspace.send();
  authWorkspace.clearConnection(); authWorkspace.selected = {session_id:'same'}; authWorkspace.setDraft('new endpoint draft');
  authWorkspace.sending = true;
  finishOldSend('{}'); await sendingOld;
  assert.equal(authWorkspace.draft,'new endpoint draft'); assert.equal(authWorkspace.sending,true);
  assert.equal(authWorkspace.notice,'','An old send must not report success on a new connection');
  const unattended = new Workspace(); unattended.selected = {session_id:'one'};
  let finishUnattended; unattended.api.request = () => new Promise(resolve => {finishUnattended = resolve;});
  const staleUnattended = unattended.loadUnattended(); unattended.epoch++; unattended.panel = 'files';
  finishUnattended('{"enabled":true,"request":"old"}'); await staleUnattended;
  assert.equal(unattended.panel,'files'); assert.equal(unattended.unattended.enabled,false);

  const copied = conversationCopy([{role:'user',text:'hello  '},{role:'tool',text:'ignore'},{role:'assistant',text:'answer'},{role:'assistant',text:'  '}]);
  assert.equal(copied.messageCount,2);assert.equal(copied.text,'## User\n\nhello\n\n---\n\n## Assistant\n\nanswer');
  assert.equal(conversationCopyFailure(new ApiError(413,'too large to export','{"max_bytes":1048576}')),'Conversation too large to copy (max 1 MiB). Use search or copy a smaller range.');
  assert.equal(conversationCopyFailure(new ApiError(413,'unrelated','{}')),'Failed to copy conversation');
  const exporting = new Workspace(); exporting.selected = {session_id:'one'};
  let finishExport; exporting.api.request = () => new Promise(resolve => {finishExport = resolve;});
  const pendingExport = exporting.exportConversation(); exporting.epoch++;
  finishExport('{"events":[{"role":"user","text":"old session"}]}');
  assert.equal(await pendingExport,undefined,'A switched session must not leak into clipboard');
  const { Activity, contextLabel, subagentText } = load(path.join(root, 'model/Activity.ets'));
  const activity = new Activity();
  activity.snapshot({ busy: true, thinking_tokens: 100, tools: 2, subagents_running: 2, subagent_details: [{role:'review', model:'provider/model',tokens:0}] });
  activity.live({live_cursor:'one',busy:true,meta_delta:{thinking_tokens:25,tool:1}},false);
  activity.snapshot({busy:true,thinking_tokens:105,tools:2,subagents_running:1,subagent_details:[{role:'review'}]});
  assert.equal(activity.thinkingTokens,125); assert.equal(activity.tools,3); assert.equal(activity.subagents,1);
  activity.live({busy:true,meta_delta:{thinking_tokens:25,tool:1}},true);
  assert.equal(activity.thinkingTokens,125, 'Replay must not count a delta twice');
  activity.live({busy:true,turn_start:true,events:[{role:'user',text:'steer'}]},false);
  assert.equal(activity.tools,3,'Steering during an open turn must not reset counters');
  activity.live({busy:false,turn_end:true},false);
  activity.live({busy:true,turn_start:true,events:[{role:'user',text:'new human turn'}],meta_delta:{tool:1}},false);
  assert.equal(activity.tools,1); assert.equal(activity.thinkingTokens,0);
  activity.live({busy:false,turn_end:true},false);
  activity.live({busy:true,turn_start:true,events:[{role:'user',text:'Background task completed: result'}]},false);
  assert.equal(activity.tools,1,'Internal delivery must not reset cumulative counters');
  const overlapping = new Activity(); overlapping.snapshot({busy:false,tools:0,thinking_tokens:0});
  overlapping.live({busy:false,events:[]},false);
  overlapping.snapshot({busy:true,tools:3,thinking_tokens:1200});
  overlapping.live({busy:true,turn_start:true,events:[{role:'user',text:'begin'}],meta_delta:{tool:3}},false);
  overlapping.snapshot({busy:true,tools:3,thinking_tokens:1200});
  assert.equal(overlapping.tools,3,'Catalog ahead of cursor must not count the same tools twice');
  overlapping.snapshot({busy:true,tools:4,thinking_tokens:1500});
  const overlappingCopy=overlapping.clone();
  overlappingCopy.live({busy:true,meta_delta:{tool:1}},false);
  assert.equal(overlappingCopy.tools,4,'Cloning preserves independent cursor and catalog totals');
  assert.equal(overlappingCopy.thinkingTokens,1500);
  overlappingCopy.snapshot({busy:true,tools:3,thinking_tokens:1400});
  assert.equal(overlappingCopy.tools,4,'A lagging snapshot cannot erase exact live tool work');
  overlappingCopy.live({busy:false,turn_end:true},false);
  overlappingCopy.snapshot({busy:true,tools:1,thinking_tokens:200});
  overlappingCopy.live({busy:true,turn_start:true,events:[{role:'user',text:'next turn'}],meta_delta:{tool:1}},false);
  overlappingCopy.snapshot({busy:true,tools:1,thinking_tokens:200});
  assert.equal(overlappingCopy.tools,1,'A catalog opening the next turn must not prevent cursor reset');
  assert.equal(overlappingCopy.thinkingTokens,200);
  assert.equal(contextLabel({context_window:1000,tokens_in_context:250,percent_remaining:75}),'Ctx 75%');
  assert.equal(contextLabel({context_window:1000}),'');
  assert.equal(subagentText({role:'Review',model:'provider/model',tools:0,tokens:1200}),'Review · model · tools: 0 · tokens: 1.2k');
  const { composerChoices } = load(path.join(root, 'model/ComposerCommands.ets'));
  const catalog = {default_backend:'pi',backends:{pi:{provider_models:{one:['m1','m2']},reasoning_efforts:['off','high']},codex:{provider_models:{chatgpt:['chat-model'],'openai-api':['api-model']}}}};
  assert.equal(composerChoices({agent_backend:'codex',slash_commands:[]},catalog,'/model ').length,0);
  assert.equal(composerChoices({agent_backend:'codex',slash_commands:[{name:'model'}],provider_choice:'chatgpt'},catalog,'/model ')[0].value,'chat-model');
  assert.equal(composerChoices({agent_backend:'pi'},catalog,'/model ')[0].value,'one/m1');
  assert.equal(composerChoices({agent_backend:'pi',pi_thinking_command:false},catalog,'/effort ').length,0);
  assert.equal(composerChoices({agent_backend:'pi',pi_thinking_command:true},catalog,'/THINKING h')[0].value,'high');

  const detailsModel = load(path.join(root,'model/SessionDetails.ets'));
  assert.equal(detailsModel.sessionDiagnostics('Launch failed'),undefined);
  const ds=detailsModel.sessionDiagnostics(JSON.stringify({session_id:'detail',agent_backend:'codex',busy:false,queue_len:0,thread_id:'thread'}));
  assert.equal(detailsModel.sessionOverview(ds).find(r=>r.label==='Queued messages').value,'0');
  assert.equal(detailsModel.sessionOverview(ds).find(r=>r.label==='Status').value,'Idle');
  assert.equal(detailsModel.technicalDetails(ds).find(r=>r.label==='Thread ID').value,'thread');
  assert.equal(detailsModel.contextDetails({percent_remaining:0}).find(r=>r.label==='Remaining').value,'0%');
  const settings = new Workspace();
  settings.selected={session_id:'change',agent_backend:'codex',slash_commands:[{name:'model'},{name:'effort'}]};
  settings.draft='An unsent draft';settings.attachments=[{id:'keep',display_name:'keep.txt'}];
  const settingCalls=[];
  settings.api.request=async(path,method,body)=>{settingCalls.push([path,method,JSON.parse(body)]);return '{}';};
  await settings.changeSessionSetting('effort','high');
  assert.deepEqual(settingCalls[0],['/api/sessions/change/settings','POST',{effort:'high'}]);
  assert.equal(settings.draft,'An unsent draft');assert.equal(settings.attachments.length,1);
  assert.equal(settings.selected.reasoning_effort,undefined); // No false current-turn confirmation.
  settings.api.request=async()=>{throw Error('rejected');};
  await assert.rejects(settings.changeSessionSetting('model','bad'),/rejected/);
  assert.equal(settings.settingBusy,false);assert.equal(settings.draft,'An unsent draft');
  settings.selected={session_id:'pi-change',agent_backend:'pi',pi_thinking_command:true};
  await assert.rejects(settings.changeSessionSetting('effort','high'),/pending message or attachment/);
  settings.attachments=[];
  settings.api.request=async(path,method,body)=>{settingCalls.push([path,method,JSON.parse(body)]);return '{}';};
  await settings.changeSessionSetting('effort','high');
  assert.deepEqual(settingCalls.at(-1),['/api/sessions/pi-change/send','POST',{text:'/effort high',allow_pending_attachment:false}]);
  assert.equal(settings.draft,'An unsent draft');
  settings.selected={session_id:'unavailable',agent_backend:'codex',slash_commands:[]};
  const count=settingCalls.length;
  await assert.rejects(settings.changeSessionSetting('effort','high'),/does not support/);
  assert.equal(settingCalls.length,count);

  const queue = new Workspace();queue.selected = {session_id:'queue'};
  queue.queue = [{id:'a',text:'one'},{id:'b',text:'barrier',commit_unknown:true},{id:'c',text:'three'}];
  let queueWrites = 0; queue.api.request = async () => {queueWrites++;return '{}';};
  assert.equal(queue.queueCanMove(0,2),false);
  await assert.rejects(queue.changeQueue('move',{id:'a',to_index:2}), /Cannot move/);
  await assert.rejects(queue.changeQueue('update',{id:'b',text:'changed'}), /recovery/);
  await assert.rejects(queue.changeQueue('delete',{id:'b'}), /Confirm/);
  queue.queue[1].sending = true;
  await assert.rejects(queue.changeQueue('delete',{id:'b',allow_commit_unknown:true}), /being sent/);
  assert.equal(queueWrites,0,'Invalid queue mutations must not reach the server');
  const liveQueue=new Workspace();liveQueue.authenticated=true;liveQueue.selected={session_id:'queue-live'};liveQueue.streamActive=true;liveQueue.panel='queue';
  let liveItems=[{id:'head',text:'Sending now',sending:true},{id:'next',text:'Following'}], liveQueueReads=0;
  liveQueue.api={request:async path=>{
    if(path==='/api/sessions')return JSON.stringify({sessions:[{session_id:'queue-live'}]});
    if(path.endsWith('/queue')){liveQueueReads++;return JSON.stringify({items:liveItems});}
    return '{}';
  }};
  await liveQueue.poll();assert.equal(liveQueue.queue[0].sending,true);assert.equal(liveQueue.queueCanMove(1,0),false);
  liveItems=[];await liveQueue.poll();assert.equal(liveQueue.queue.length,0,'An open queue removes acknowledged prompts without reopening');
  liveQueue.queueChanging=true;await liveQueue.poll();assert.equal(liveQueueReads,2,'Polling must not race a queue mutation');
  liveQueue.queueChanging=false;liveQueue.panel='';await liveQueue.poll();assert.equal(liveQueueReads,2,'Closed queue does not add polling work');
  const history = new EditHistory(); history.reset('original'); history.change('first'); history.change('second');
  assert.equal(history.undo(), 'first'); assert.equal(history.redo(), 'second');
  history.undo(); history.change('replacement'); assert.equal(history.redo(), 'replacement');
  const tokens = codeLines('return "# not a comment" # comment', 'python')[0].tokens;
  assert.equal(tokens.find(t => t.kind === 'string').text, '"# not a comment"');
  assert.equal(tokens.find(t => t.kind === 'comment').text, '# comment');
  assert.equal(markdownBlocks('```python\na < b\n```')[0].text, 'a < b');

  const nested = markdownBlocks('> **bold *nested***\n\n- [x] Done\n  - Child\n\n[reference][ref]\n\n[ref]: https://example.com');
  assert.equal(nested[0].quote,1); assert.equal(nested[0].parts[1].bold,true); assert.equal(nested[0].parts[1].italic,true);
  assert.equal(nested[1].checked,1); assert.equal(nested[2].indent,2); assert.equal(nested[3].parts[0].url,'https://example.com');
  assert.equal(inlineParts('~~gone~~')[0].strike,true);
  assert.equal(inlineParts('[unsafe](javascript:alert)')[0].url,'');
  assert.equal(inlineParts('a_b_c')[0].text,'a_b_c');
  const table = markdownBlocks('| Name | Value |\n| :--- | ---: |\n| a\\|b | **2** |')[0];
  assert.equal(table.rows[1][0],'a|b'); assert.equal(table.align[1],'right'); assert.equal(table.table[1][1][0].bold,true);
  assert.equal(markdownBlocks('before ![demo](chart.png) after')[1].kind,'image');
  assert.equal(inlineParts('Energy $E=mc^2$.')[1].math,'E=mc^2');
  assert.equal(markdownBlocks('$$\\frac{1}{2}$$')[0].kind,'math');
  assert.equal(inlineParts('Price $5 and $10').some(part=>part.math),false);
  assert.equal(inlineParts('`$x$`')[0].code,true);
  assert.equal(markdownBlocks('```tex\n$x$\n```')[0].text,'$x$');
  const { renderFormula } = load(path.join(root,'vendor/math.js'));
  const fraction = JSON.parse(renderFormula('\\frac{1}{2}', '#322d27', true));
  assert.ok(fraction.width>0 && fraction.height>20, 'Fractions need real layout dimensions');
  assert.match(fraction.svg,/<svg/); assert.match(fraction.svg,/<path/);
  assert.equal(/<script|<foreignObject|<iframe/.test(fraction.svg),false);
  const undefinedBefore = JSON.parse(renderFormula('\\nativeLeak', '#111111', true));
  renderFormula('\\newcommand{\\nativeLeak}{XYZ}\\nativeLeak', '#322d27', true);
  const separate = JSON.parse(renderFormula('\\nativeLeak', '#222222', true));
  assert.equal(separate.svg.replaceAll('#222222','#111111'), undefinedBefore.svg, 'Macros from one message cannot mutate another expression');
  assert.throws(() => renderFormula('x'.repeat(10001), '#322d27', true), /too long/);
  const integral = JSON.parse(renderFormula('\\int_0^1 x^2\\,dx=\\frac{1}{3}', '#ffffff', true));
  assert.ok(integral.width>fraction.width); assert.match(integral.svg,/#ffffff/);
  for (const background of ['#fdea9d', '#6b5a1e']) {
    const highlighted = JSON.parse(renderFormula('\\frac{1}{2}', '#322d27', true, background));
    assert.equal(highlighted.width, fraction.width);
    assert.equal(highlighted.height, fraction.height);
    assert.match(highlighted.svg, new RegExp('<rect[^>]+fill="' + background + '"'));
    assert.equal(highlighted.svg.replace(/<rect[^>]*><\/rect>/, ''), fraction.svg, 'Highlight preserves formula paths and layout');
  }
  assert.equal(renderFormula('\\frac{1}{2}', '#322d27', true, 'red" onclick="bad'), JSON.stringify(fraction));
  assert.equal(renderFormula('\\frac{1}{2}', '#322d27', true), JSON.stringify(fraction), 'Clearing highlight restores the original cached vector');



  const workspace = new Workspace();
  const writes = [];
  workspace.api.request = async (url, method, body) => { writes.push({url, method, body}); return '{}'; };
  workspace.selected = { session_id: 'one' }; workspace.setDraft('first draft');
  workspace.selected = { session_id: 'two' }; workspace.setDraft('second draft');
  await flushDrafts();
  assert.equal(writes.filter(w => w.url === '/api/sessions/one/draft').length, 1);
  assert.equal(JSON.parse(writes.find(w => w.url === '/api/sessions/two/draft').body).text, 'second draft');

  const shared=new Workspace();shared.selected={session_id:'shared'};
  let remoteDraft={text:'from browser',updated_ts:20};
  shared.api={request:async(url,method,body)=>{
    if(url==='/api/sessions')return JSON.stringify({sessions:[{session_id:'shared',draft_updated_ts:remoteDraft.updated_ts}]});
    if(method==='POST')remoteDraft={text:JSON.parse(body).text,updated_ts:remoteDraft.updated_ts+1};
    return JSON.stringify(remoteDraft);
  }};
  await shared.reconcileDraft('shared');assert.equal(shared.draft,'from browser');
  shared.setDraft('from browser');assert.equal(shared.draftPending.size,0,'Programmatic TextArea echo is not a local edit');
  remoteDraft={text:'browser changed',updated_ts:21};await shared.refresh();assert.equal(shared.draft,'browser changed');
  remoteDraft={text:'',updated_ts:22};await shared.refresh();assert.equal(shared.draft,'','Remote send/clear propagates to a clean composer');
  shared.setDraft('local typing');remoteDraft={text:'concurrent remote',updated_ts:23};await shared.refresh();
  assert.equal(shared.draft,'local typing','Catalog must not overwrite unsynchronized typing');
  await flushDrafts();assert.equal(remoteDraft.text,'local typing');assert.equal(shared.draftPending.size,0);
  assert.equal(shared.draftStamps.get('shared'),24);
  let lateDraft;shared.api.request=()=>new Promise(r=>{lateDraft=r;});
  const pulling=shared.reconcileDraft('shared');shared.setDraft('typed during read');lateDraft(JSON.stringify({text:'late response',updated_ts:25}));await pulling;
  assert.equal(shared.draft,'typed during read','A late read cannot overwrite edits made while it was in flight');shared.dispose();
  shared.draftPending.clear();
  const oldLoginRead=shared.reconcileDraft('shared');shared.authEpoch++;lateDraft(JSON.stringify({text:'previous login',updated_ts:26}));await oldLoginRead;
  assert.equal(shared.draft,'typed during read','Old login responses cannot change the new login');

  const retryDraft=new Workspace();retryDraft.selected={session_id:'retry'};let retryCalls=0;
  retryDraft.api={request:async()=>{retryCalls++;if(retryCalls===1)throw new Error('offline');return JSON.stringify({updated_ts:30});}};
  retryDraft.setDraft('keep and retry');await flushDrafts();assert.equal(retryDraft.draftPending.get('retry'),'keep and retry');
  retryDraft.flushDraft('retry');await flushDrafts();assert.equal(retryCalls,2);assert.equal(retryDraft.draftPending.size,0);assert.equal(retryDraft.draft,'keep and retry');
  const serialized=new Workspace();serialized.selected={session_id:'serial'};const draftRequests=[];
  serialized.api={request:(_url,_method,body)=>new Promise(resolve=>draftRequests.push({text:JSON.parse(body).text,resolve}))};
  serialized.setDraft('first');await flushDrafts();serialized.setDraft('second');await flushDrafts();
  assert.equal(draftRequests.length,1,'Only one write per session may be in flight');
  draftRequests[0].resolve(JSON.stringify({updated_ts:40}));await flushDrafts();await flushDrafts();
  assert.equal(draftRequests.length,2);assert.equal(draftRequests[1].text,'second');
  draftRequests[1].resolve(JSON.stringify({updated_ts:41}));await flushDrafts();assert.equal(serialized.draftPending.size,0);
  const missingRemote=new Workspace();missingRemote.selected={session_id:'missing'};missingRemote.rememberDraft('missing','local only');missingRemote.draft='local only';
  missingRemote.api={request:async()=>JSON.stringify({text:'',updated_ts:0})};await missingRemote.reconcileDraft('missing');
  assert.equal(missingRemote.draft,'local only');assert.equal(missingRemote.draftPending.get('missing'),'local only','No server record is not a deletion');missingRemote.dispose();

  const send = new Workspace();
  let resolveSend;
  send.selected = { session_id: 'one' }; send.setDraft('submitted');
  const saved = [];
  send.api.request = async (url, method, body) => {
    if (url.endsWith('/send')) await new Promise(resolve => { resolveSend = resolve; });
    if (url.endsWith('/draft')) saved.push(JSON.parse(body).text);
    return '{}';
  };
  const sending = send.send();
  send.setDraft('new typing while send is pending'); resolveSend(); await sending; await flushDrafts();
  assert.equal(send.draft, 'new typing while send is pending');
  assert.equal(saved.at(-1), 'new typing while send is pending');

  const file = new Workspace();
  let resolveSave;
  file.selected = { session_id: 'one' }; file.activeFile = { rel: 'a.py', editable: true, text: 'old', version: 'v1' };
  file.fileText = 'submitted file'; file.fileDirty = true;
  file.api.request = async () => { await new Promise(resolve => { resolveSave = resolve; }); return '{"version":"v2"}'; };
  const saving = file.saveFile(); file.fileText = 'new edit while saving'; resolveSave(); await saving;
  assert.equal(file.activeFile.text, 'submitted file'); assert.equal(file.fileText, 'new edit while saving'); assert.equal(file.fileDirty, true);

  const stream = new Workspace();
  stream.selected = { session_id: 'one' };
  let receive;
  stream.api.request = async url => url.includes('messages/tail') ? JSON.stringify({ events: [{ message_id: 'old', role: 'user', text: 'old transcript' }], transcript_state: 'bound', thread_id: 'old-thread', log_path: '/old', live_cursor: 'cursor', busy: false }) : '{}';
  stream.api.stream = (url, handler) => { receive = handler; return () => {}; };
  await stream.select({ session_id: 'one' });
  stream.activity.tools = 12;
  receive('message', JSON.stringify({events:[],transcript_state:'pending_bind',live_cursor:'',busy:true}));
  assert.equal(stream.events[0].text,'old transcript','Pending log binding must keep readable content');
  receive('message', JSON.stringify({ events: [{ message_id: 'new', role: 'user', text: 'new transcript' }], transcript_state: 'bound', thread_id: 'new-thread', log_path: '/new', live_cursor: 'next', busy: false }));
  assert.equal(stream.events.length, 1); assert.equal(stream.events[0].text, 'new transcript');
  assert.equal(stream.activity.tools,0,'A new transcript must not retain old tool counters');
  const search = new Workspace();
  let resolveSearch;
  search.selected = { session_id: 'one' };
  search.api.request = async url => {
    if (url.includes('/search?')) return await new Promise(resolve => { resolveSearch = resolve; });
    return '{}';
  };
  const searching = search.search('old session');
  await search.select({ session_id: 'two' });
  resolveSearch('{"matches":[{"text":"wrong session"}]}'); await searching;
  assert.equal(search.searchMatches.length, 0, 'A late result must not populate another session');

  const pagedSearch = new Workspace(); pagedSearch.selected = {session_id:'one'};
  let searchedBefore = false;
  pagedSearch.api.request = async url => {
    if (url.includes('/search?')) {
      const older = url.includes('before=c3'); searchedBefore ||= older;
      return JSON.stringify({matches:(older ? [1,2] : [3,4]).map(n => ({message_id:'m'+n,history_cursor:'c'+n,text:'match '+n})),total:older ? 2 : 4});
    }
    if (url.includes('/messages/window?')) { const cursor = /cursor=([^&]+)/.exec(url)[1]; return JSON.stringify({events:[{message_id:'m'+cursor.slice(1),history_cursor:cursor,role:'user',text:'match'}]}); }
    return '{}';
  };
  await pagedSearch.search('match'); assert.equal(pagedSearch.searchBase,2);assert.equal(pagedSearch.searchIndex,1);
  await pagedSearch.stepSearch(-1); assert.equal(pagedSearch.events[0].message_id,'m3');
  await pagedSearch.stepSearch(-1); assert.ok(searchedBefore); assert.equal(pagedSearch.events[0].message_id,'m2');assert.equal(pagedSearch.searchTotal,4);assert.equal(pagedSearch.searchBase,0);
  await pagedSearch.stepSearch(-1); assert.equal(pagedSearch.events[0].message_id,'m1');
  await pagedSearch.stepSearch(-1); assert.equal(pagedSearch.events[0].message_id,'m4');
  await pagedSearch.stepSearch(1); assert.equal(pagedSearch.events[0].message_id,'m1');
  pagedSearch.api.request = async () => await new Promise(resolve => { resolveSearch = resolve; });
  const cancelledSearch = pagedSearch.search('later'); pagedSearch.clearSearch();
  resolveSearch(JSON.stringify({matches:[{text:'late'}],total:1})); await cancelledSearch;
  assert.equal(pagedSearch.searchMatches.length,0); assert.equal(pagedSearch.searchQuery,''); assert.equal(pagedSearch.searchLoading,false);

  const windows = new Workspace(); windows.selected = { session_id: 'one' };
  let live;
  windows.api.stream = (url, handler) => { live = handler; return () => {}; };
  windows.api.request = async url => {
    if (url.includes('messages/window')) { assert.match(url, /cursor=before-match/); return JSON.stringify({ events: [{message_id:'historic', role:'user', text:'matched historical message'}], has_older:true, history_cursor:'older' }); }
    if (url.includes('messages/tail')) return JSON.stringify({events:[{message_id:'latest',role:'assistant',text:'latest'}], live_cursor:'live', busy:true, has_older:true});
    return '{}';
  };
  await windows.select({session_id:'one'});
  await windows.jump({history_cursor:'before-match',load_cursor:'after-match'});
  assert.equal(windows.busy, true, 'A history response without runtime fields must not clear busy');
  live('message', JSON.stringify({events:[{message_id:'streamed',role:'assistant',text:'new stream'}],live_cursor:'new-live',busy:false,has_older:false}));
  assert.equal(windows.events[0].message_id,'historic'); assert.equal(windows.hasOlder,true);
  await windows.latest(); assert.equal(windows.events[0].message_id,'latest'); assert.equal(windows.browsingHistory,false);
  const historyRace = new Workspace(); historyRace.selected = {session_id:'one'};
  let finishWindow;
  historyRace.api.request = async url => url.includes('messages/window') ? await new Promise(resolve=>{finishWindow=resolve;}) : JSON.stringify({events:[{message_id:'newest',role:'assistant',text:'latest'}]});
  const oldWindow = historyRace.jump({history_cursor:'old'});
  await historyRace.latest(); finishWindow(JSON.stringify({events:[{message_id:'old',role:'user',text:'old'}]}));
  assert.equal(await oldWindow,-1);assert.equal(historyRace.events[0].message_id,'newest','An old history response cannot overwrite Latest');
  const reconnect = new Workspace(); reconnect.authenticated = true;
  reconnect.draft = 'preserved offline'; reconnect.error = 'existing action error';
  reconnect.api.request = async () => { throw new ApiError(503,'unavailable',''); };
  await reconnect.poll(); assert.match(reconnect.connectionStatus,/Reconnecting/);
  assert.equal(reconnect.draft,'preserved offline'); assert.equal(reconnect.authenticated,true);
  reconnect.api.request = async () => '{"sessions":[]}';
  await reconnect.poll(); assert.equal(reconnect.connectionStatus,'');
  assert.equal(reconnect.error,'existing action error','Reconnection must not erase unrelated action errors');
  const orphan = new Workspace();orphan.authenticated=true;let orphanReads=[];
  const orphanRow={session_id:'orphan',orphan_recovery:true,queue_len:1};
  orphan.api.request=async url=>{orphanReads.push(url);assert.equal(url,'/api/sessions','Missing broker must not receive transcript/draft requests');return JSON.stringify({sessions:[orphanRow]});};
  await orphan.select(orphanRow);await orphan.poll();orphan.setDraft('preserve locally');await orphan.send();
  assert.match(orphan.error,/only be reviewed/);assert.equal(orphan.draft,'preserve locally');assert.equal(orphanReads.length,1);
  const removed = new Workspace(); removed.authenticated=true; removed.selected={session_id:'removed'};
  removed.draft='keep my draft';removed.events=[{role:'user',text:'old'}];removed.panel='queue';removed.queue=[{id:'q',text:'queued'}];
  let streamClosed=false;removed.closeStream=()=>{streamClosed=true;};
  let endQueue;removed.api.request=async url=>url.endsWith('/queue')?await new Promise(resolve=>endQueue=resolve):'{"sessions":[]}';
  const lateQueue=removed.loadQueue();await removed.poll();
  endQueue('{"items":[{"id":"late","text":"stale"}]}');await lateQueue;
  assert.equal(removed.selected,undefined);assert.equal(removed.sidebar,true);assert.equal(removed.panel,'');
  assert.equal(streamClosed,true);assert.equal(removed.events.length,0);assert.equal(removed.queue.length,0);
  assert.equal(removed.drafts.get('removed'),'keep my draft');assert.match(removed.notice,/no longer available/);
  const catalogRace=new Workspace();catalogRace.selected={session_id:'present'};
  const catalogReads=[];catalogRace.api.request=()=>new Promise(resolve=>catalogReads.push(resolve));
  const earlierCatalog=catalogRace.refresh();const laterCatalog=catalogRace.refresh();
  catalogReads[1]('{"sessions":[{"session_id":"present"}]}');await laterCatalog;
  catalogReads[0]('{"sessions":[]}');await earlierCatalog;
  assert.equal(catalogRace.selected.session_id,'present','Old empty catalog must not remove a current selection');
  const beforeSelection=catalogRace.refresh();catalogRace.selected={session_id:'new-selection'};
  catalogReads[2]('{"sessions":[]}');await beforeSelection;
  assert.equal(catalogRace.selected.session_id,'new-selection','Catalog begun before a new selection cannot clear it');
  const queueRace = new Workspace(); queueRace.selected = {session_id:'queue-race'};
  const queueReads = [];
  queueRace.api.request = () => new Promise(resolve => queueReads.push(resolve));
  const oldQueue = queueRace.loadQueue(); const newQueue = queueRace.loadQueue();
  queueReads[1]('{"items":[{"id":"new","text":"current"}]}'); await newQueue;
  queueReads[0]('{"items":[{"id":"old","text":"stale"}]}'); await oldQueue;
  assert.equal(queueRace.queue[0].id,'new','An older queue read cannot overwrite the latest response');
  let releaseQueue; let mutations = 0;
  queueRace.action = async () => { mutations++; await new Promise(resolve => releaseQueue = resolve); };
  queueRace.loadQueue = async () => {};
  const mutation = queueRace.changeQueue('edit',{id:'new',text:'edited'});
  await assert.rejects(queueRace.changeQueue('delete',{id:'new'}), /current queue change/);
  assert.equal(mutations,1); releaseQueue(); await mutation;
  assert.equal(queueRace.queueChanging,false);
  const navigation = new Workspace(); navigation.selected = {session_id:'navigation'};
  navigation.events = [{role:'user',text:'first',message_id:'u1',history_cursor:'first'}, {role:'assistant',text:'answer'}, {role:'user',text:'second',message_id:'u2',history_cursor:'second'}];
  assert.equal(await navigation.navigateUser(0,1),2); assert.equal(await navigation.navigateUser(2,-1),0);
  navigation.api.request = async url => {
    if (url.includes('/messages/neighbor?')) return '{"neighbor":{"message_id":"older","history_cursor":"older-cursor"}}';
    return '{"events":[{"role":"assistant","text":"before"},{"role":"user","text":"older","message_id":"older","history_cursor":"older-cursor"}]}';
  };
  assert.equal(await navigation.navigateUser(0,-1),1,'Unloaded navigation must materialize the target window and return its index');
  assert.equal(navigation.browsingHistory,true); assert.equal(navigation.events[1].message_id,'older');
  console.log('PASS: activity counters/replays, backend command capabilities, editor, Markdown, drafts, send/save races, transcript replacement, stale search, history window');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
