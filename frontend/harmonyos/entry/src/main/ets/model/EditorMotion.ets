// UTF-16 offsets match the native TextArea controller; motions keep surrogate pairs intact.
export interface EditorChange { text: string; cursor: number; }
export function previousCharacter(text: string, cursor: number): number {
  let index = Math.max(0, Math.min(cursor, text.length) - 1);
  if (index > 0 && /[\uDC00-\uDFFF]/.test(text[index]) && /[\uD800-\uDBFF]/.test(text[index - 1])) index--;
  return index;
}
export function nextCharacter(text: string, cursor: number): number {
  return Math.min(text.length, cursor + ((text.codePointAt(cursor) || 0) > 65535 ? 2 : 1));
}
export function lineStart(text: string, cursor: number): number { return cursor <= 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1; }
export function lineEnd(text: string, cursor: number): number { const index = text.indexOf('\n', cursor); return index < 0 ? text.length : index; }
function characterKind(value: string): number { return /\s/.test(value) ? 0 : /[\p{L}\p{N}_]/u.test(value) ? 1 : 2; }
export function moveCursor(text: string, cursor: number, key: string, lines: number = 1): number {
  let at = Math.max(0, Math.min(cursor, text.length));
  if (key === 'h') return previousCharacter(text, at);
  if (key === 'l') return nextCharacter(text, at);
  if (key === '0') return lineStart(text, at);
  if (key === '$') return lineEnd(text, at);
  if (key === 'gg') return 0;
  if (key === 'G') return text.lastIndexOf('\n') + 1;
  if (key === 'j' || key === 'k') {
    const column = Array.from(text.slice(lineStart(text, at), at)).length;
    let start = lineStart(text, at);
    for (let i = 0; i < lines; i++) {
      if (key === 'j') { const end = lineEnd(text, start); if (end >= text.length) break; start = end + 1; }
      else { if (start === 0) break; start = lineStart(text, start - 1); }
    }
    return start + Array.from(text.slice(start, lineEnd(text, start))).slice(0, column).join('').length;
  }
  if (key === 'w') {
    if (at < text.length) { const kind = characterKind(String.fromCodePoint(text.codePointAt(at)!)); do { at = nextCharacter(text, at); } while (at < text.length && characterKind(String.fromCodePoint(text.codePointAt(at)!)) === kind); }
    while (at < text.length && /\s/.test(text[at])) at = nextCharacter(text, at);
  } else if (key === 'b') {
    at = previousCharacter(text, at);
    while (at > 0 && /\s/.test(text[at])) at = previousCharacter(text, at);
    const kind = characterKind(String.fromCodePoint(text.codePointAt(at) || 32));
    while (at > 0 && characterKind(String.fromCodePoint(text.codePointAt(previousCharacter(text, at))!)) === kind) at = previousCharacter(text, at);
  } else if (key === 'e') {
    at = nextCharacter(text, at);
    while (at < text.length && /\s/.test(text[at])) at = nextCharacter(text, at);
    const kind = characterKind(String.fromCodePoint(text.codePointAt(at) || 32));
    while (nextCharacter(text, at) < text.length && characterKind(String.fromCodePoint(text.codePointAt(nextCharacter(text, at))!)) === kind) at = nextCharacter(text, at);
  }
  return at;
}
export function editAtCursor(text: string, cursor: number, verb: string): EditorChange {
  const at = Math.max(0, Math.min(cursor, text.length));
  const start = lineStart(text, at); const end = lineEnd(text, at);
  if (verb === 'x') return { text: text.slice(0, at) + text.slice(nextCharacter(text, at)), cursor: at };
  if (verb === 'dd') {
    const first = end === text.length && start > 0 ? start - 1 : start;
    const last = end < text.length ? end + 1 : end;
    const result = text.slice(0, first) + text.slice(last);
    return { text: result, cursor: Math.min(start, result.length) };
  }
  if (verb === 'o') return { text: text.slice(0, end) + '\n' + text.slice(end), cursor: end + 1 };
  if (verb === 'O') return { text: text.slice(0, start) + '\n' + text.slice(start), cursor: start };
  return { text: text, cursor: at };
}
