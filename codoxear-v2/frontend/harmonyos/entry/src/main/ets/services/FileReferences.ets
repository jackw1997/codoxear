import { http } from '@kit.NetworkKit';
import { ApiClient } from './ApiClient';

interface InspectRequest { session_id: string; paths: string[]; }
interface Inspection { exists: boolean; resolved_path?: string; kind?: string; api_path?: string; path_token?: string; }
interface Inspections { results: Inspection[]; }
interface FileMatch { path: string; api_path?: string; }
interface FileSearch { matches: FileMatch[]; truncated?: boolean; mode?: string; }
interface SingleInspection { path: string; kind: string; api_path?: string; path_token?: string; }
interface SingleRequest { session_id: string; path: string; path_token?: string; git_path: boolean; }
export interface ResolvedReference { path: string; target: string; apiPath?: string; choice?: boolean; directory?: boolean; }

// Discovery is read-only and scoped to this authenticated connection and session.
// Ambiguous bare names open the picker rather than silently selecting one file.
export async function inspectReferences(api: ApiClient, session: string, paths: string[]): Promise<ResolvedReference[]> {
  const version = api.connectionVersion();
  const pathsToInspect = Array.from(new Set(paths));
  const direct: string[] = [];
  const output: ResolvedReference[] = [];
  for (const path of pathsToInspect) {
    if (path.includes('/')) { direct.push(path); continue; }
    const search = JSON.parse(await api.request('/api/sessions/' + encodeURIComponent(session) + '/file/search?q=' + encodeURIComponent(path) + '&limit=80')) as FileSearch;
    api.requireConnection(version);
    const matches = search.matches.filter((item: FileMatch) => item.path.split('/').pop() === path);
    if (search.truncated || matches.length > 1) { output.push({ path: path, target: path, choice: true }); continue; }
    if (!matches.length) { direct.push(path); continue; }
    // Git-backed search still returns paths relative to the session cwd.
    const body: SingleRequest = { session_id: session, path: matches[0].path, path_token: matches[0].api_path, git_path: false };
    try {
      const result = JSON.parse(await api.request('/api/files/inspect', http.RequestMethod.POST, JSON.stringify(body))) as SingleInspection;
      api.requireConnection(version);
      if (result.path) output.push({ path: path, target: result.path, apiPath: result.api_path || result.path_token, directory: result.kind === 'directory' });
    } catch (_) { api.requireConnection(version); }
  }
  for (let offset = 0; offset < direct.length; offset += 50) {
    const chunk = direct.slice(offset, offset + 50);
    const body: InspectRequest = { session_id: session, paths: chunk };
    const response = JSON.parse(await api.request('/api/files/inspect-batch', http.RequestMethod.POST, JSON.stringify(body))) as Inspections;
    api.requireConnection(version);
    response.results.forEach((item: Inspection, index: number) => {
      if (index < chunk.length && item.exists && item.resolved_path) output.push({ path: chunk[index], target: item.resolved_path, apiPath: item.api_path || item.path_token, directory: item.kind === 'directory' });
    });
  }
  return output;
}
