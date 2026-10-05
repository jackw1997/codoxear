import { Session, Transcript, TokenUsage, SubagentDetail } from './Contracts';
function count(value: number | undefined | null): number { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0; }
export function compactCount(value: number): string {
  return value >= 1000000 ? (value / 1000000).toFixed(1) + 'M' : value >= 1000 ? (value / 1000).toFixed(1) + 'k' : '' + value;
}
export function subagentText(detail: SubagentDetail): string {
  const parts = [detail.role?.trim() || 'Subagent'];
  if (detail.model?.trim()) parts.push(detail.model.trim().split('/').pop() || '');
  if (typeof detail.tools === 'number' && Number.isFinite(detail.tools) && detail.tools >= 0) parts.push('tools: ' + Math.floor(detail.tools));
  if (typeof detail.tokens === 'number' && Number.isFinite(detail.tokens) && detail.tokens >= 0) parts.push('tokens: ' + compactCount(detail.tokens));
  return parts.join(' · ');
}
export function contextLabel(token: TokenUsage | undefined | null): string {
  if (!token || typeof token.context_window !== 'number' || !Number.isFinite(token.context_window) || token.context_window <= 0 || typeof token.tokens_in_context !== 'number' || !Number.isFinite(token.tokens_in_context) || token.tokens_in_context < 0) return '';
  return 'Ctx' + (typeof token.percent_remaining === 'number' && Number.isFinite(token.percent_remaining) ? ' ' + Math.round(Math.max(0, Math.min(100, token.percent_remaining))) + '%' : '');
}
// Catalog totals and cursor deltas describe overlapping work. Keep independent
// totals, seed the live baseline once on selection, and display their maximum.
// Adding a delta to a newer catalog total would count the same work twice.
export class Activity {
  turnOpen: boolean = false;
  thinking: number = 0;
  thinkingTokens: number = 0;
  tools: number = 0;
  subagents: number = 0;
  details: SubagentDetail[] = [];
  token: TokenUsage | null = null;
  queue: number = 0;
  private seeded: boolean = false;
  private liveTurnOpen: boolean = false;
  private liveThinking: number = 0;
  private liveThinkingTokens: number = 0;
  private liveTools: number = 0;
  private catalogThinking: number = 0;
  private catalogThinkingTokens: number = 0;
  private catalogTools: number = 0;
  private publish(): void {
    this.thinking = Math.max(this.catalogThinking, this.liveThinking);
    this.thinkingTokens = Math.max(this.catalogThinkingTokens, this.liveThinkingTokens);
    this.tools = Math.max(this.catalogTools, this.liveTools);
  }
  snapshot(session: Session): void {
    this.catalogThinking = count(session.thinking); this.catalogThinkingTokens = count(session.thinking_tokens); this.catalogTools = count(session.tools);
    if (!this.seeded) {
      this.liveThinking = this.catalogThinking; this.liveThinkingTokens = this.catalogThinkingTokens; this.liveTools = this.catalogTools;
      this.liveTurnOpen = !!session.busy; this.seeded = true;
    }
    this.publish();
    this.subagents = count(session.subagents_running); this.details = session.subagent_details || [];
    this.token = session.token || null; this.queue = count(session.queue_len); this.turnOpen = !!session.busy;
  }
  live(data: Transcript, duplicate: boolean): void {
    if (data.token !== undefined) this.token = data.token;
    if (data.queue_len !== undefined) this.queue = count(data.queue_len);
    if (!duplicate) {
      this.seeded = true;
      const newTurn = !this.liveTurnOpen && (data.turn_start || data.busy);
      if (newTurn && (data.events || []).some(event => event.role === 'user' && !event.agent_internal_delivery && !['**📨 From ', 'Subagent progress update.', 'Background task completed:'].some((prefix: string) => (event.text || '').trimStart().startsWith(prefix)))) {
        this.liveThinking = 0; this.liveThinkingTokens = 0; this.liveTools = 0;
        this.catalogThinking = 0; this.catalogThinkingTokens = 0; this.catalogTools = 0;
      }
      if (data.meta_delta) {
        this.liveThinking += count(data.meta_delta.thinking); this.liveThinkingTokens += count(data.meta_delta.thinking_tokens); this.liveTools += count(data.meta_delta.tool);
      }
      this.publish();
      if (data.turn_boundaries?.length) data.turn_boundaries.forEach((boundary: string) => { this.turnOpen = boundary === 'start'; });
      else {
        if (data.turn_start) this.turnOpen = true;
        if (data.turn_end || data.turn_aborted) this.turnOpen = false;
      }
    }
    const terminal = data.turn_boundaries?.length ? data.turn_boundaries[data.turn_boundaries.length - 1] !== 'start' : data.turn_end || data.turn_aborted;
    if (!this.turnOpen && (data.turn_activity || data.busy) && !terminal) this.turnOpen = true;
    if (!duplicate) this.liveTurnOpen = this.turnOpen;
  }
  label(busy: boolean): string {
    if (!busy) return '▸' + this.subagents + ' subagent' + (this.subagents === 1 ? '' : 's') + ' working';
    const parts: string[] = [];
    if (this.tools) parts.push('tools: ' + this.tools);
    if (this.thinkingTokens) parts.push('thinking: ' + compactCount(this.thinkingTokens));
    if (this.subagents) parts.push('subagents: ' + this.subagents);
    return parts.join(' · ') || 'working';
  }
  clone(): Activity {
    const next = new Activity();
    next.turnOpen = this.turnOpen; next.thinking = this.thinking; next.thinkingTokens = this.thinkingTokens; next.tools = this.tools;
    next.subagents = this.subagents; next.details = this.details; next.token = this.token; next.queue = this.queue;
    next.seeded = this.seeded; next.liveTurnOpen = this.liveTurnOpen;
    next.liveThinking = this.liveThinking; next.liveThinkingTokens = this.liveThinkingTokens; next.liveTools = this.liveTools;
    next.catalogThinking = this.catalogThinking; next.catalogThinkingTokens = this.catalogThinkingTokens; next.catalogTools = this.catalogTools;
    return next;
  }
}
