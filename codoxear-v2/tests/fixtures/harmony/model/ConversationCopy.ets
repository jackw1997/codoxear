import { ChatEvent } from './Contracts';
import { ApiError } from '../services/ApiClient';
export interface ConversationCopy { text: string; messageCount: number; }
interface ExportFailure { error?: string; max_bytes?: number; }
export function conversationCopy(events: ChatEvent[]): ConversationCopy {
  const parts: string[] = [];
  events.forEach((event: ChatEvent) => {
    if (event.role !== 'user' && event.role !== 'assistant') return;
    const text = (event.text || '').replace(/\s+$/g, '');
    if (!text.trim()) return;
    const date = event.ts !== undefined && Number.isFinite(event.ts) ? ' (' + new Date(event.ts * 1000).toLocaleString() + ')' : '';
    parts.push('## ' + (event.role === 'user' ? 'User' : 'Assistant') + date + '\n\n' + text);
  });
  return { text: parts.join('\n\n---\n\n').trim(), messageCount: parts.length };
}
export function conversationCopyFailure(error: Error): string {
  if (error instanceof ApiError && error.status === 413) {
    try {
      const data = JSON.parse(error.payload) as ExportFailure;
      const text = (data.error || error.message).toLowerCase();
      if (data.max_bytes !== undefined && (text.includes('transcript-export-too-large') || text.includes('too large to export') || (text.includes('transcript') && text.includes('too large') && text.includes('export')))) {
        const bytes = data.max_bytes;
        let limit = '';
        if (Number.isFinite(bytes) && bytes > 0) {
          const value = bytes >= 1048576 ? bytes / 1048576 : bytes >= 1024 ? bytes / 1024 : bytes;
          limit = Number(value.toFixed(bytes >= 1024 ? 1 : 0)).toString() + (bytes >= 1048576 ? ' MiB' : bytes >= 1024 ? ' KiB' : ' bytes');
        }
        return 'Conversation too large to copy' + (limit ? ' (max ' + limit + ')' : '') + '. Use search or copy a smaller range.';
      }
    } catch (_) {}
  }
  return 'Failed to copy conversation';
}
