import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/AllPackages.js';
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
function createDocument() { return mathjax.document('', {
  InputJax: new TeX({ packages: ['base', 'ams', 'newcommand', 'boldsymbol', 'color', 'configmacros', 'mathtools', 'cancel', 'unicode', 'noundefined'], maxBuffer: 20000, maxMacros: 1000 }),
  OutputJax: new SVG({ fontCache: 'none' })
}); }
const cache = new Map();
export function renderFormula(latex, color, display, background = '') {
  const backdrop = /^#[\da-f]{6}$/i.test(background) ? background : '';
  const key = JSON.stringify([latex,color,display,backdrop]);
  if (cache.has(key)) return cache.get(key);
  if (latex.length > 10000) throw new Error('Formula is too long');
  // TeX definitions are scoped to one expression, never a different message.
  const document = createDocument();
  const node = document.convert(latex, {display:!!display, em:16, ex:8, containerWidth:1280});
  const svgNode = adaptor.firstChild(node);
  if (backdrop) {
    const [x, y, width, height] = adaptor.getAttribute(svgNode, 'viewBox').split(/\s+/);
    const rect = adaptor.node('rect', { x, y, width, height, fill: backdrop });
    adaptor.insert(rect, adaptor.firstChild(svgNode));
  }
  let svg = adaptor.outerHTML(svgNode);
  const width = parseFloat(adaptor.getAttribute(svgNode,'width')) * 8;
  const height = parseFloat(adaptor.getAttribute(svgNode,'height')) * 8;
  const ink = /^#[\da-f]{6}$/i.test(color) ? color : '#322d27';
  svg = svg.replace(/currentColor/g, ink);
  const result = JSON.stringify({ svg, width:Math.max(1,width), height:Math.max(16,height) });
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(key,result);
  return result;
}
