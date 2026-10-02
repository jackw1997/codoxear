// Preserve the web client's delimiter rules while leaving native code spans intact.
export function extractMath(input) {
  const expressions = [];
  const push = (latex, display) => {
    const index = expressions.length;
    expressions.push({latex:String(latex).trim(), display});
    return '\uE000MATH' + index + '\uE001';
  };
  let text = String(input).replaceAll('\r\n','\n');
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_raw, body) => push(body,true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_raw, body) => push(body,false));
  let fence = null;
  text = text.split('\n').map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence=null;
      return line;
    }
    if (marker) { fence=marker[1]; return line; }
    return line.split(/(`+[^`]*`+)/g).map((part,index) => index%2 ? part : part
      .replace(/\$\$([\s\S]+?)\$\$/g, (_raw,body) => push(body,true))
      .replace(/\$(?!\$|\s)([^$\n]*?\S)\$(?!\$|\d)/g, (_raw,body) => push(body,false))).join('');
  }).join('\n');
  return {text,expressions};
}
export function mathRuns(text, style, expressions) {
  return String(text).split(/(\uE000MATH\d+\uE001)/).filter(Boolean).map(value => {
    const match=value.match(/^\uE000MATH(\d+)\uE001$/);
    const expression=match && expressions[Number(match[1])];
    return expression ? {...style,text:expression.latex,math:expression.latex,display:expression.display} : {...style,text:value};
  });
}
