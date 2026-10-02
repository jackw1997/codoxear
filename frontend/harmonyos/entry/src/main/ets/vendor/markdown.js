import marked from './marked';
import { extractMath, mathRuns } from './math_tokens';

const options = { gfm: true, breaks: true };
const cache = new Map();
const plain = () => ({bold:false, italic:false, code:false, strike:false, url:'', image:false, math:'', display:false});
function safeLink(url) {
  const value = String(url || '').trim();
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
  if ((/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/]+\.[^/:]+:\d+(?::\d+)?$/.test(value)) || value.startsWith('//')) return '';
  return value;
}
function decode(text) {
  const names = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0',copy:'©',reg:'®',hellip:'…',mdash:'—',ndash:'–'};
  return String(text || '').replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (raw, key) => {
    if (key[0] !== '#') return names[key] || raw;
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : parseInt(key.slice(1),10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
  });
}
function runs(tokens, style = plain(), expressions = []) {
  return (tokens || []).flatMap(token => {
    if (token.type === 'strong') return runs(token.tokens, {...style,bold:true}, expressions);
    if (token.type === 'em') return runs(token.tokens, {...style,italic:true}, expressions);
    if (token.type === 'del') return runs(token.tokens, {...style,strike:true}, expressions);
    if (token.type === 'link') return runs(token.tokens, {...style,url:safeLink(token.href)}, expressions);
    if (token.type === 'image') return [{...style,text:decode(token.text),url:safeLink(token.href),image:true}];
    if (token.type === 'codespan') return [{...style,text:token.text,code:true}];
    if (token.type === 'br') return [{...style,text:'\n'}];
    if (token.tokens) return runs(token.tokens,style,expressions);
    return mathRuns(decode(token.text ?? token.raw), style, expressions);
  });
}
function citationLine(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : null; }
  function rewriteOaiMemCitations(rawText) {
    const raw = String(rawText ?? "");
    if (!raw.includes("<oai-mem-citation>")) return raw;
    const blockRe = /<oai-mem-citation>\s*<citation_entries>\s*([\s\S]*?)\s*<\/citation_entries>\s*<rollout_ids>[\s\S]*?<\/rollout_ids>\s*<\/oai-mem-citation>/g;
    return raw.replace(blockRe, (whole, body) => {
      const lines = String(body || "").split("\n").map((line) => line.trim()).filter(Boolean);
      if (!lines.length) return whole;
      const items = [];
      for (const line of lines) {
        const m = line.match(/^(.*?):(\d+)(?:-(\d+))?\|note=\[(.*)\]$/);
        if (!m) return whole;
        const relPath = String(m[1] || "").trim().replace(/^\.?\//, "");
        const startLine = citationLine(m[2]);
        const endLine = citationLine(m[3]);
        const note = String(m[4] || "").trim();
        if (!relPath || !startLine || !note) return whole;
        const range = endLine && endLine >= startLine ? `#L${startLine}-${endLine}` : `#L${startLine}`;
        items.push(`[${note}](~/.codex/memories/${relPath}${range})`);
      }
      return `\n---\n\nMemory citations:\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
    });
  }

function block(kind, token, context) {
  return {kind,text:token.text || '',level:token.depth || 0,language:token.lang || '',url:'',rows:[],table:[],align:[],parts:[],indent:context.indent,quote:context.quote,prefix:'',checked:-1};
}
function flatten(tokens, context={indent:0,quote:0}, expressions=[]) {
  const output=[];
  for (const token of tokens) {
    if (token.type === 'space' || token.type === 'def') continue;
    if (token.type === 'blockquote') { output.push(...flatten(token.tokens,{...context,quote:context.quote+1},expressions)); continue; }
    if (token.type === 'list') {
      token.items.forEach((item,index) => {
        const rows=flatten(item.tokens,{...context,indent:context.indent+1},expressions);
        if (rows.length) {
          rows[0].checked=item.task ? (item.checked ? 1 : 0) : -1;
          rows[0].prefix=item.task ? '' : token.ordered ? String(Number(token.start)+index)+'.' : '•';
        }
        output.push(...rows);
      });
      continue;
    }
    const item=block(token.type==='hr'?'rule':token.type,token,context);
    if (token.type === 'table') {
      item.rows=[token.header,...token.rows].map(row=>row.map(cell=>cell.text));
      item.table=[token.header,...token.rows].map(row=>row.map(cell=>runs(cell.tokens,plain(),expressions)));
      item.align=token.align.map(value=>value || 'left');
    } else if (token.type !== 'code') item.parts=runs(token.tokens || marked.Lexer.lexInline(token.text || token.raw || '',options),plain(),expressions);
    // Promote inline images to native blocks, preserving surrounding text order.
    if (item.parts.some(part=>part.image || part.display)) {
      let pending=[];
      for (const part of item.parts) {
        if (!part.image && !part.display) {pending.push(part);continue;}
        if (pending.length) {output.push({...item,parts:pending});pending=[];}
        output.push({...item,kind:part.image?'image':'math',text:part.text,url:part.url,parts:[]});
      }
      if (pending.length) output.push({...item,parts:pending,prefix:''});
    } else output.push(item);
  }
  return output;
}
export function parseBlocks(text) {
  if (cache.has(text)) return cache.get(text);
  const extracted=extractMath(rewriteOaiMemCitations(text));
  const result=JSON.stringify(flatten(marked.lexer(extracted.text,options),{indent:0,quote:0},extracted.expressions));
  if (text.length < 100000) {
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(text,result);
  }
  return result;
}
export function parseInline(text) { const extracted=extractMath(text); return JSON.stringify(runs(marked.Lexer.lexInline(extracted.text,options),plain(),extracted.expressions)); }
