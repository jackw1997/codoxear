import hljs from 'highlight.js';
// Pinned highlight.js 11 emitter interface. It emits native spans, never HTML.
class NativeEmitter {
  constructor() { this.tokens=[];this.scopes=[]; }
  addText(text) { if(text)this.tokens.push({text,kind:this.scopes[this.scopes.length-1]||'plain'}); }
  startScope(scope) { this.scopes.push(scope); }
  endScope() { this.scopes.pop(); }
  openNode(scope) { this.startScope(scope); }
  closeNode() { this.endScope(); }
  __addSublanguage(emitter) { this.tokens.push(...emitter.tokens); }
  finalize() { this.scopes=[];return true; }
  toHTML() { return ''; }
}
hljs.configure({__emitter:NativeEmitter});
const aliases={ets:'typescript',ts:'typescript',tsx:'typescript',jsx:'javascript',js:'javascript',mjs:'javascript',cjs:'javascript',py:'python',rb:'ruby',rs:'rust',sh:'bash',zsh:'bash',yml:'yaml',md:'markdown',h:'c',hpp:'cpp',vue:'xml',svg:'xml',html:'xml',htm:'xml',kt:'kotlin',kts:'kotlin',cs:'csharp',dockerfile:'dockerfile',makefile:'makefile'};
const cache=new Map();
function language(hint) {
  const name=String(hint||'').toLowerCase().split(/[\\/]/).pop();
  const extension=name.includes('.')?name.split('.').pop():name;
  return aliases[extension]||extension;
}
function kind(scope) {
  if(/comment|doctag/.test(scope))return 'comment';
  if(/string|regexp/.test(scope))return 'string';
  if(/number/.test(scope))return 'number';
  if(/keyword|built_in|literal/.test(scope))return 'keyword';
  if(/title|type/.test(scope))return 'type';
  if(/attr|property|selector/.test(scope))return 'attribute';
  return 'plain';
}
export function nativeHighlight(text, hint='') {
  const lang=language(hint),key=lang+'\0'+text;
  if(cache.has(key))return cache.get(key);
  let tokens=[{text,kind:'plain'}];
  if(text.length<=1000000 && hljs.getLanguage(lang)) {
    try {
      const result=hljs.highlight(text,{language:lang,ignoreIllegals:true});
      if(!result.errorRaised)tokens=result._emitter.tokens.map(t=>({text:t.text,kind:kind(t.kind)}));
    }
    catch(_) {}
  }
  const lines=[{number:1,offset:0,text:'',tokens:[]}];
  let offset=0;
  for(const token of tokens) {
    const pieces=token.text.split('\n');
    pieces.forEach((piece,index)=> {
      if(index) { offset++;lines.push({number:lines.length+1,offset,text:'',tokens:[]}); }
      const line=lines[lines.length-1];
      line.text+=piece;offset+=piece.length;
      if(piece)line.tokens.push({text:piece,kind:token.kind});
    });
  }
  for(const line of lines)if(!line.tokens.length)line.tokens.push({text:'',kind:'plain'});
  const result=JSON.stringify(lines);
  if(text.length<64000) { if(cache.size>=16)cache.delete(cache.keys().next().value);cache.set(key,result); }
  return result;
}
