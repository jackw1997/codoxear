export function fileLink(base: string, target: string): string {
  if (!base || !target || target.startsWith('/') || target.startsWith('~/') || target.startsWith('#') || (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[^/]+\.[^/:]+:\d+(?::\d+)?$/.test(target))) return target;
  const directory = base.slice(0, base.lastIndexOf('/') + 1);
  const parts: string[] = [];
  (directory + target).split('/').forEach((part: string) => {
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  });
  return (base.startsWith('/') ? '/' : '') + parts.join('/');
}

export interface FileLocation { path: string; location: string; }
export function fileLocation(target: string): FileLocation {
  const hash = target.indexOf('#');
  if (hash >= 0) return { path: target.slice(0, hash), location: target.slice(hash) };
  const line = target.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (line) return { path: line[1], location: '#L' + line[2] };
  return { path: target, location: '' };
}

// Display paths may contain escaped raw bytes. Carry the server's reversible
// identity separately so navigation never interprets the display as a filename.
export interface FileReferenceLink { path: string; location: string; apiPath: string; }
export function fileReferenceLink(path: string, location: string, apiPath: string = ''): string {
  if (!apiPath) return path + location;
  const reference: FileReferenceLink = { path: path, location: location, apiPath: apiPath };
  return 'codoxear-file:' + encodeURIComponent(JSON.stringify(reference));
}
export function parseFileReferenceLink(url: string): FileReferenceLink | null {
  if (!url.startsWith('codoxear-file:')) return null;
  try {
    const reference = JSON.parse(decodeURIComponent(url.slice('codoxear-file:'.length))) as FileReferenceLink;
    if (typeof reference.path !== 'string' || !reference.path || typeof reference.location !== 'string' || typeof reference.apiPath !== 'string') return null;
    return reference;
  } catch (_) { return null; }
}
