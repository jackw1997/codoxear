import parse from 'css-tree/parser';
const colors = {ink:'ink',paper:'paper',background:'bg',wash:'wash',hairline:'hairline',panel:'panel',border:'border',text:'text',muted:'muted',accent:'accent',primary:'accent-strong',onPrimary:'on-accent',danger:'danger',userBubble:'bubble-user',assistantBubble:'bubble-assistant',activeSession:'session-active',code:'surface-code',subtle:'surface-subtle'};
function color(value) {
  if (/^#[\da-f]{3}$/i.test(value)) return '#'+[...value.slice(1)].map(x=>x+x).join('');
  if (/^#[\da-f]{4}$/i.test(value)) return '#'+[value[4],value[1],value[2],value[3]].map(x=>x+x).join('');
  if (/^#[\da-f]{8}$/i.test(value)) return '#'+value.slice(7,9)+value.slice(1,7);
  if (/^#[\da-f]{6}$/i.test(value) || /^(transparent|black|white|red|green|blue|gray|grey|yellow)$/i.test(value)) return value;
  const rgb=value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgb) return '#'+[rgb[4]===undefined?255:Math.round(Number(rgb[4])*255),...rgb.slice(1,4).map(Number)].map(n=>Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0')).join('');
  return '';
}
function rootSelector(selector, family, mode) {
  const attrs=[...selector.matchAll(/\[data-(theme|mode)\s*=\s*["']?([\w-]+)["']?\]/g)];
  if (attrs.some(m=>m[2] !== (m[1]==='theme'?family:mode))) return -1;
  const remaining=selector.replace(/\[data-(?:theme|mode)\s*=\s*["']?[\w-]+["']?\]/g,'').trim();
  if (![':root','html','body'].includes(remaining) && !(remaining === '' && attrs.length)) return null;
  return (remaining===':root'?10:1)+attrs.length*10;
}
function mediaMatches(query,width,mode) {
  let unsupported=false;
  const branches=query.split(',').map(branch=> {
    let rest=branch.toLowerCase().trim().replace(/^(?:only\s+)?(?:screen|all)\s*(?:and\s*)?/, '');
    let match=true;
    rest=rest.replace(/\(\s*(min-width|max-width|prefers-color-scheme)\s*:\s*([^)]*)\)/g,(_,key,value)=> {
      value=value.trim();
      if(key==='prefers-color-scheme') match=match && value===mode;
      else if(/^\d+(?:\.\d+)?px$/.test(value)) match=match && (key==='min-width'?width>=parseFloat(value):width<=parseFloat(value));
      else unsupported=true;
      return '';
    }).replace(/\band\b/g,'').trim();
    if(rest)unsupported=true;
    return match;
  });
  return unsupported ? null : branches.some(Boolean);
}
const componentSelectors = {
  user: ['.msg', '.msg.user', '.msg-row.user .msg', '.msg-shell.user .msg'],
  assistant: ['.msg', '.msg.assistant', '.msg-row.assistant .msg', '.msg-shell.assistant .msg']
};
function componentSelector(selector, family, mode) {
  let prefixScore=0;
  const scoped=selector.match(/^((?::root|html|body)?(?:\[data-(?:theme|mode)\s*=\s*["']?[\w-]+["']?\])+|:root|html|body)\s+(.+)$/);
  if(scoped) {
    prefixScore=rootSelector(scoped[1],family,mode);
    if(prefixScore===-1)return [];
    if(prefixScore===null)return null;
    selector=scoped[2];
  }
  selector=selector.replace(/\s+/g,' ').trim();
  const matches=Object.entries(componentSelectors).filter(([,selectors])=>selectors.includes(selector)).map(([key])=>({key,score:prefixScore+(selector.match(/\./g)||[]).length*10}));
  return matches.length?matches:null;
}
function componentDefaults(base) {
  const one=background=>({background,color:base.text,fontSize:16,lineHeight:base.family==='clay'?1.55:base.family==='slate'?1.6:1.35,paddingTop:10,paddingRight:12,paddingBottom:18,paddingLeft:12,radius:base.bubbleRadius,borderWidth:1,borderColor:base.family==='slate'?'transparent':base.family==='clay'?base.hairline:base.ink,maxWidth:760});
  const result={user:one(base.userBubble),assistant:one(base.assistantBubble)};
  if(base.family==='slate')result.assistant.paddingLeft=result.assistant.paddingRight=4;
  return result;
}
function dimension(value) { return /^(?:0|\d+(?:\.\d+)?px)$/.test(value)?parseFloat(value):null; }
function componentProperty(style, name, value) {
  const colorProps={'color':'color','background':'background','background-color':'background','border-color':'borderColor'};
  if(name in colorProps) { const result=color(value); if(!result)return false;style[colorProps[name]]=result;return true; }
  const sizeProps={'font-size':'fontSize','border-radius':'radius','border-width':'borderWidth','padding-top':'paddingTop','padding-right':'paddingRight','padding-bottom':'paddingBottom','padding-left':'paddingLeft','max-width':'maxWidth'};
  if(name in sizeProps) { const result=dimension(value);if(result===null)return false;style[sizeProps[name]]=result;return true; }
  if(name==='line-height' && /^\d+(?:\.\d+)?$/.test(value) && Number(value)>0) {style.lineHeight=Number(value);return true;}
  if(name==='padding') {
    const parts=value.split(/\s+/).map(dimension);if(parts.length>4||parts.some(v=>v===null))return false;
    [style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft]=[parts[0],parts[1]??parts[0],parts[2]??parts[0],parts[3]??parts[1]??parts[0]];return true;
  }
  return false;
}
export function nativeCss(source, baseJson, variablesJson, width) {
  const base=JSON.parse(baseJson), variables=JSON.parse(variablesJson), winners=new Map(), warnings=new Set(), componentWinners={user:new Map(),assistant:new Map()};
  if(!source.trim())return JSON.stringify({palette:base,components:componentDefaults(base),warnings:[]});
  try {
    const ast=parse(source,{positions:true,parseCustomProperty:true,onParseError:()=>warnings.add('Some CSS could not be parsed.')});
    function generate(node) { return source.slice(node.loc.start.offset,node.loc.end.offset); }
    function visit(children) {
      children.forEach(node=> {
        if(node.type==='Atrule') {
          if(node.name.toLowerCase()==='media' && node.block) {
            const matches=mediaMatches(generate(node.prelude),width,base.mode);
            if(matches===null)warnings.add('This media query is not supported yet.');
            else if(matches)visit(node.block.children);
          } else warnings.add('@'+node.name+' is not supported yet.');
          return;
        }
        if(node.type!=='Rule' || node.prelude.type!=='SelectorList')return;
        let score=-1; const scores=new Map();
        node.prelude.children.forEach(selector=> {
          const result=rootSelector(generate(selector),base.family,base.mode);
          if(result===null) {
            const matches=componentSelector(generate(selector),base.family,base.mode);
            if(matches===null)warnings.add('Unsupported selector: '+generate(selector));
            else for(const match of matches)scores.set(match.key,Math.max(scores.get(match.key)||0,match.score));
          }
          else score=Math.max(score,result);
        });
        if(score<0 && !scores.size)return;
        node.block.children.forEach(decl=> {
          if(decl.type!=='Declaration')return;
          const value=generate(decl.value).trim();
          for(const [key,specificity] of scores) {
            const rank=(decl.important?100000:0)+specificity;
            const properties=decl.property==='background'?['background-color']:decl.property==='padding'?['padding-top','padding-right','padding-bottom','padding-left']:[decl.property];
            const deferredPadding=decl.property==='padding' && value.includes('var(');
            const parts=decl.property==='padding'?value.split(/\s+/):[value];
            const values=decl.property==='padding'?[parts[0],parts[1]??parts[0],parts[2]??parts[0],parts[3]??parts[1]??parts[0]]:[value];
            if(decl.property==='padding' && !deferredPadding && (parts.length>4 || parts.some(v=>dimension(v)===null))) { warnings.add('Unsupported padding value.'); continue; }
            for(let i=0;i<properties.length;i++) {
              const previous=componentWinners[key].get(properties[i]);
              if(!previous || rank>=previous.rank)componentWinners[key].set(properties[i],{rank,value:deferredPadding?value:values[i],paddingPart:deferredPadding?i:undefined});
            }
          }
          if(score<0)return;
          if(!decl.property.startsWith('--')) {warnings.add('Only theme variables are supported here yet.');return;}
          const rank=(decl.important?100000:0)+score;
          const previous=winners.get(decl.property);
          if(!previous || rank>=previous.rank)winners.set(decl.property,{rank,value});
        });
      });
    }
    visit(ast.children);
    winners.forEach((entry,key)=>{variables[key.slice(2)]=entry.value;});
    function resolve(value, seen=new Set(), context=variables) {
      const input=String(value||'').replace(/\/\*[\s\S]*?\*\//g,'');
      let output='',position=0;
      while(position<input.length) {
        const start=input.indexOf('var(',position);
        if(start<0) { output+=input.slice(position);break; }
        output+=input.slice(position,start);
        let end=start+4,depth=1,comma=-1;
        for(;end<input.length && depth;end++) {
          if(input[end]==='(')depth++;
          else if(input[end]===')')depth--;
          else if(input[end]===',' && depth===1 && comma<0)comma=end;
        }
        if(depth)return '';
        const name=input.slice(start+4,comma<0?end-1:comma).trim();
        if(!/^--[\w-]+$/.test(name))return '';
        const key=name.slice(2),next=new Set(seen);next.add(key);
        let replacement=!seen.has(key) && key in context ? resolve(context[key],next,context):'';
        if(!replacement && comma>=0)replacement=resolve(input.slice(comma+1,end-1),seen,context);
        if(!replacement)return '';
        output+=replacement;position=end;
      }
      return output.trim();
    }
    for(const [field,variable] of Object.entries(colors)) {
      const resolved=color(resolve(variables[variable]));
      if(resolved)base[field]=resolved;
      else if(winners.has('--'+variable))warnings.add('Invalid or unsupported color: --'+variable);
    }
    for(const [field,variable] of Object.entries({radius:'radius-control',cardRadius:'radius-card',bubbleRadius:'radius-bubble'})) {
      if(!winners.has('--'+variable))continue;
      const value=resolve(variables[variable]);
      if(/^(?:0|\d+(?:\.\d+)?px)$/.test(value))base[field]=Math.max(0,parseFloat(value));
      else warnings.add('Invalid or unsupported size: --'+variable);
    }
    const components=componentDefaults(base);
    for(const [key,entries] of Object.entries(componentWinners)) {
      const context={...variables};
      entries.forEach((entry,property)=>{if(property.startsWith('--'))context[property.slice(2)]=entry.value;});
      entries.forEach((entry,property)=>{
        if(property.startsWith('--'))return;
        let value=resolve(entry.value,new Set(),context);
        if(entry.paddingPart!==undefined) {
          const parts=value.split(/\s+/);
          if(parts.length>4 || parts.some(part=>dimension(part)===null)) { warnings.add('Invalid padding value.'); return; }
          value=[parts[0],parts[1]??parts[0],parts[2]??parts[0],parts[3]??parts[1]??parts[0]][entry.paddingPart];
        }
        if(!componentProperty(components[key],property,value))warnings.add('Unsupported value or property: '+property);
      });
    }
    return JSON.stringify({palette:base,components,warnings:[...warnings]});
  } catch (_) {warnings.add('CSS could not be parsed.');}
  return JSON.stringify({palette:base,components:componentDefaults(base),warnings:[...warnings]});
}
