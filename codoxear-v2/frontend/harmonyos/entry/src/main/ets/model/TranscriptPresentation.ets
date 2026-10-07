import { ChatEvent } from './Contracts';

export function transcriptDay(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp * 1000);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
export function transcriptDayLabel(timestamp: number, now: number = Date.now()): string {
  const day = transcriptDay(timestamp);
  if (!day) return '';
  const date = new Date(timestamp * 1000); const today = new Date(now);
  const elapsed = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86400000);
  return elapsed === 0 ? 'Today (' + day + ')' : elapsed === 1 ? 'Yesterday (' + day + ')' : day;
}
export function startsTranscriptDay(events: ChatEvent[], index: number): boolean {
  const day = transcriptDay(events[index]?.ts || 0);
  if (!day) return false;
  for (let previous = index - 1; previous >= 0; previous--) {
    const before = transcriptDay(events[previous].ts || 0);
    if (before) return day !== before;
  }
  return true;
}
export function transcriptGap(events: ChatEvent[], index: number): number {
  if (index <= 0) return 6;
  const event = events[index]; const previous = events[index - 1];
  const day = transcriptDay(event.ts || 0);
  return day && day === transcriptDay(previous.ts || 0) && (event.role === 'user') === (previous.role === 'user') ? 2 : 6;
}
