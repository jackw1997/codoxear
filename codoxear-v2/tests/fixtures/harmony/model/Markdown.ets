import { fileLocation } from './FileLinks';
import { parseBlocks, parseInline } from '../vendor/markdown';

export interface InlinePart { text: string; bold: boolean; italic: boolean; code: boolean; strike: boolean; url: string; image: boolean; math: string; display: boolean; highlight?: boolean; candidate?: string; choice?: boolean; }
export interface MarkdownBlock {
  kind: string; text: string; level: number; language: string; url: string;
  rows: string[][]; table: InlinePart[][][]; align: string[]; parts: InlinePart[];
  indent: number; quote: number; prefix: string; checked: number;
  anchor?: string;
}
// Marked produces data only. Every visible element remains a native ArkUI node.
export function markdownBlocks(text: string): MarkdownBlock[] {
  const blocks = JSON.parse(parseBlocks(text)) as MarkdownBlock[];
  const used: Set<string> = new Set();
  blocks.forEach((block: MarkdownBlock) => {
    if (block.kind !== 'heading') return;
    const base = block.parts.map((part: InlinePart) => part.text).join('').toLowerCase().replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '').replace(/\s/g, '-');
    let anchor = base; let count = 0;
    while (used.has(anchor)) anchor = base + '-' + (++count);
    used.add(anchor); block.anchor = anchor;
  });
  return blocks;
}
export function inlineParts(text: string): InlinePart[] { return JSON.parse(parseInline(text)) as InlinePart[]; }

// Search spans preserve formatting and links, including matches crossing style boundaries.
export function highlightedParts(parts: InlinePart[], query: string): InlinePart[] {
  if (!query) return parts;
  const text = parts.map((part: InlinePart) => part.text).join('');
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const ranges: number[][] = [];
  let match = pattern.exec(text);
  while (match) { ranges.push([match.index, match.index + match[0].length]); match = pattern.exec(text); }
  if (!ranges.length) return parts;
  const result: InlinePart[] = [];
  let offset = 0;
  for (const part of parts) {
    const end = offset + part.text.length;
    if (part.math || part.image) {
      // A formula is one vector, not separable text spans. Mark the whole
      // expression when a source match intersects it; never split its TeX.
      result.push({ text: part.text, bold: part.bold, italic: part.italic, code: part.code,
        strike: part.strike, url: part.url, image: part.image, math: part.math,
        display: part.display, candidate: part.candidate,
        highlight: !!part.math && ranges.some((range: number[]) => range[0] < end && range[1] > offset) });
      offset = end; continue;
    }
    const cuts: number[] = [offset, end];
    for (const range of ranges) {
      if (range[0] > offset && range[0] < end) cuts.push(range[0]);
      if (range[1] > offset && range[1] < end) cuts.push(range[1]);
    }
    cuts.sort((a: number, b: number) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      if (cuts[i] === cuts[i + 1]) continue;
      result.push({ text: part.text.slice(cuts[i] - offset, cuts[i + 1] - offset), bold: part.bold,
        italic: part.italic, code: part.code, strike: part.strike, url: part.url, image: part.image,
        math: part.math, display: part.display, candidate: part.candidate, highlight: ranges.some((range: number[]) => cuts[i] >= range[0] && cuts[i] < range[1]) });
    }
    offset = end;
  }
  return result;
}

// Empty hard-break fragments are not measurable text. Some native SDK versions
// return a negative sentinel for them; never add that sentinel to a line width.
export function measureInlineWidth(parts: InlinePart[], measure: (text: string, part: InlinePart) => number): number {
  let line = 0;
  let widest = 0;
  for (const part of parts) {
    const lines = part.text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (index > 0) { widest = Math.max(widest, line); line = 0; }
      if (!lines[index]) continue;
      const width = measure(lines[index], part);
      if (!Number.isFinite(width) || width <= 0) return Number.POSITIVE_INFINITY;
      line += width;
    }
  }
  return Math.max(widest, line);
}

// Recognize the same path-shaped prose tokens as the web renderer. Inline code,
// links and math are deliberately excluded; candidates need server validation.
const fileExtensions: string[] = '7z 3gp avi bash bin bz2 c cc cfg conf cpp css csv flv gif go gz h hpp html htm ico ini java jpeg jpg js json jsonl log m4v md mkv mov mp4 mpeg mpg ogv pdf patch png py rs scss sh sql svg tar tgz toml ts tsx txt webm webp wmv xml xz yaml yml zip zsh'.split(' ');
function referencePart(part: InlinePart, text: string, candidate: string = ''): InlinePart {
  return { text: text, bold: part.bold, italic: part.italic, code: part.code, strike: part.strike, url: part.url, image: part.image, math: part.math, display: part.display, highlight: part.highlight, candidate: candidate };
}
export function fileReferenceParts(parts: InlinePart[]): InlinePart[] {
  const output: InlinePart[] = [];
  for (const part of parts) {
    if (part.code || part.url || part.math || part.image) { output.push(part); continue; }
    const pattern = /(^|[\s([{"'])((?:\/[A-Za-z0-9._~@%+=:,/-]+|(?:\.{1,2}\/)?[A-Za-z0-9._~@-]+(?:\/[A-Za-z0-9._~@-]+)+|[A-Za-z0-9._~@-]+\.[A-Za-z0-9._-]+)(?:#L\d+(?:-\d+)?)?(?::\d+(?::\d+)?)?)(?=$|[\s)\]}:;"',!?])/g;
    let previous = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(part.text)) !== null) {
      const location = fileLocation(match[2]);
      if (!location.path.includes('/') && !fileExtensions.includes(location.path.split('.').pop()?.toLowerCase() || '')) continue;
      const start = match.index + match[1].length;
      if (start > previous) output.push(referencePart(part, part.text.slice(previous, start)));
      output.push(referencePart(part, match[2], match[2]));
      previous = start + match[2].length;
    }
    if (previous < part.text.length) output.push(referencePart(part, part.text.slice(previous)));
  }
  return output;
}
