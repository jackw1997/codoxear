import { fileIo as fs } from '@kit.CoreFileKit';
import { renderFormula } from '../vendor/math';

interface Formula { svg: string; width: number; height: number; }
export interface MathAsset { source: string; width: number; height: number; }
const assets: Map<string, MathAsset> = new Map();
let sequence: number = 0;
// MathJax's pure JS adaptor emits SVG paths. ArkUI renders those vectors directly.
export function mathAsset(latex: string, color: string, display: boolean, cacheDir: string, background: string = ''): MathAsset {
  const key = JSON.stringify([latex, color, display, cacheDir, background]);
  const cached = assets.get(key);
  if (cached) return cached;
  try {
    const formula = JSON.parse(renderFormula(latex, color, display, background)) as Formula;
    const path = cacheDir + '/formula-' + Date.now() + '-' + (++sequence) + '.svg';
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try { fs.writeSync(file.fd, formula.svg); } finally { fs.closeSync(file); }
    const asset: MathAsset = { source: 'file://' + path, width: formula.width, height: formula.height };
    if (assets.size >= 256) {
      const oldest: string = assets.keys().next().value;
      assets.delete(oldest);
    }
    assets.set(key, asset);
    return asset;
  } catch (_) { return { source: '', width: 0, height: 0 }; }
}

// Called before the first page is loaded; never delete a vector still in use.
export function clearMathCache(cacheDir: string): void {
  assets.clear();
  try {
    fs.listFileSync(cacheDir).forEach((name: string) => {
      if (/^formula-\d+-\d+\.svg$/.test(name)) {
        try { fs.unlinkSync(cacheDir + '/' + name); } catch (_) {}
      }
    });
  } catch (_) {}
}
